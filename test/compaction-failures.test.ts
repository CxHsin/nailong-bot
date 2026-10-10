import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModel } from "@mariozechner/pi-ai";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { createContextProjection } from "../src/context/context-budget.js";
import { createCheckpointStore } from "../src/context/checkpoint.js";
import { sourceDigest } from "../src/runtime/event-digest.js";

const summary = ["Goal", "Progress", "Constraints", "Decisions", "Next Steps", "Critical Context"]
  .map((heading) => `## ${heading}\n${"Keep recorded evidence and the remaining task. ".repeat(3)}`).join("\n");
const model = { ...getModel("deepseek", "deepseek-v4-flash"), contextWindow: 18000, maxTokens: 1024 };

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "compaction-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  for (let index = 0; index < 4; index++) {
    await log.append({ type: "message", role: "user", text: `ORIGINAL-${index} ` + "x".repeat(6000) });
    await log.append({ type: "message", role: "assistant", text: "y".repeat(5000) });
  }
  await log.append({ type: "message", role: "user", requestId: "current", text: "CURRENT must remain" });
  return { dir, log };
}

test("cancellation after summary generation but before checkpoint acceptance preserves original history", async (t) => {
  const { dir, log } = await fixture(t);
  const controller = new AbortController();
  const projection = createContextProjection({ log, dataDir: dir, requestId: "current", signal: controller.signal,
    compaction: { trigger: 0.4, target: 0.3 }, summarize: async () => {
      setImmediate(() => controller.abort(new DOMException("cancelled", "AbortError")));
      return summary;
    } });
  await assert.rejects(projection.project(model, { messages: [] }), { name: "AbortError" });
  assert.equal((await log.read()).filter((event) => event.type === "context_checkpoint_committed").length, 0);
  assert.equal((await readdir(join(dir, "checkpoints"))).length, 0, "unaccepted files are removed");
  const restored = await createContextProjection({ log, dataDir: dir, requestId: "current",
    compaction: { trigger: 0.9, target: 0.8 }, summarize: async () => { throw new Error("no compaction expected"); } }).project(model, { messages: [] });
  assert.match(JSON.stringify(restored.context.messages), /ORIGINAL-3/);
});

test("a second accepted attempt replaces the history after an invalid summary", async (t) => {
  const { dir, log } = await fixture(t);
  let attempts = 0;
  const result = await createContextProjection({ log, dataDir: dir, requestId: "current",
    compaction: { trigger: 0.4, target: 0.3 }, summarize: async () => ++attempts === 1 ? "invalid" : summary }).project(model, { messages: [] });
  assert.equal(attempts, 2);
  assert.match(JSON.stringify(result.context.messages), /历史摘要/);
  assert.equal((await log.read()).filter((event) => event.type === "context_checkpoint_committed").length, 1);
});

test("summary timeout uses the bounded retry and preserves the previous context without a checkpoint", async (t) => {
  const { dir, log } = await fixture(t);
  let attempts = 0;
  const result = await createContextProjection({ log, dataDir: dir, requestId: "current",
    compaction: { trigger: 0.4, target: 0.3 }, summarize: async () => { attempts++; throw new DOMException("provider timeout", "TimeoutError"); } }).project(model, { messages: [] });
  assert.equal(attempts, 2);
  assert.match(JSON.stringify(result.context.messages), /ORIGINAL-3/);
  assert.equal((await log.read()).filter((event) => event.type === "context_checkpoint_committed").length, 0);
});

test("failed authoritative checkpoint write preserves the previously accepted summary and removes the orphan", async (t) => {
  const { dir, log } = await fixture(t);
  const events = await log.read();
  const value = { boundary: "test", through: 2, sourceDigest: sourceDigest(events.slice(0, 2)),
    lastEventDigest: sourceDigest(events[1]), summaryStrategy: "structured-text-v1" as const,
    summary, model: "test/model", ratio: 0.86 };
  const store = createCheckpointStore(dir, "structured-text-v1", undefined, log);
  const previous = await store.save(value);
  // The persistence boundary fails before accepting the new durable fact.
  const failedStore = createCheckpointStore(dir, "structured-text-v1", undefined, {
    ...log, append: async () => { throw new Error("disk commit unavailable"); },
  });
  await assert.rejects(failedStore.save({ ...value, previousId: previous.id, summary: summary + " replacement" }), /disk commit unavailable/);
  assert.equal((await store.load("test", events))?.id, previous.id);
  assert.equal((await readdir(join(dir, "checkpoints"))).length, 1);
});

test("current explicit Skill instructions survive compaction of settled tool iterations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-skill-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  await log.append({ type: "message", role: "user", requestId: "current", text: "CURRENT task" });
  await log.append({ type: "skill_loaded", requestId: "current", mode: "explicit", source: "local", name: "inspect",
    root: dir, digest: "v1", body: "SKILL_REQUIRED: verify all evidence" });
  for (let index = 0; index < 6; index++) {
    const id = `read-${index}`;
    await log.append({ type: "model_message", requestId: "current", message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 0 } });
    await log.append({ type: "tool_dispatch", requestId: "current", toolCallId: id, toolName: "read", args: {} });
    await log.append({ type: "tool_result", requestId: "current", toolCallId: id, toolName: "read",
      modelVisible: "original", result: { content: [{ type: "text", text: "original evidence ".repeat(350) }] } });
  }
  let calls = 0;
  const result = await createContextProjection({ log, dataDir: dir, requestId: "current", structured: false,
    compaction: { trigger: 0.4, target: 0.3 }, summarize: async () => { calls++; return summary; } }).project(model, { messages: [] });
  assert.equal(calls, 1, "preserved user/Skill instructions do not block legal settled-tool boundaries");
  assert.match(JSON.stringify(result.context.messages), /SKILL_REQUIRED: verify all evidence/);
  assert.match(JSON.stringify(result.context.messages), /CURRENT task/);
  assert.match(JSON.stringify(result.context.messages), /历史摘要/);
});
