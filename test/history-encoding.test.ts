import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";
import { assistantText } from "../src/agent/model-message.js";
import { sourceDigest } from "../src/runtime/event-digest.js";
import { historicalMemoryContext } from "../src/application/historical-memory-context.js";
import { createMemoryBootstrap } from "../src/application/memory-bootstrap.js";

test("historical memory input preserves its causal recent range and recorded bounded tool bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "historical-input-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const model = getModel("openai", "gpt-4o-mini");
  for (let index = 0; index < 6; index++) {
    const requestId = `old-${index}`;
    await log.append({ type: "message", role: "user", requestId, text: `question-${index}` });
    if (index === 4) {
      const result = { content: [{ type: "text" as const, text: "RAW ORIGINAL DETAILS ".repeat(1000) }], details: {}, isError: false };
      const archive = await log.archive(result);
      const recorded = { content: [{ type: "text" as const, text: "EXACT FROZEN VIEW" }], details: { view: "bounded" }, sourceDigest: sourceDigest({ result, archive }) };
      const message = assistantText("", model);
      message.content = [{ type: "toolCall", id: "historical-call", name: "read", arguments: { path: "evidence.txt" } }];
      await log.append({ type: "model_message", requestId, modelStepId: "historical-step", protocolVersion: "plain-text-v3", message });
      await log.append({ type: "tool_dispatch", requestId, toolCallId: "historical-call", toolName: "read", args: { path: "evidence.txt" } });
      await log.append({ type: "tool_result", requestId, toolCallId: "historical-call", toolName: "read", result, archive,
        modelVisible: "archive", modelProjectionVersion: 3, modelProjection: { ...recorded, digest: sourceDigest(recorded) } });
    }
    if (index < 5) {
      await log.append({ type: "answer_generated", requestId, text: `settled-${index}` });
      await log.append({ type: "delivery_succeeded", requestId });
      await log.append({ type: "request_completed", requestId });
    }
  }
  const source = await log.read();
  await log.append({ type: "message", role: "user", requestId: "future", text: "FUTURE MUST NOT APPEAR" });
  const input = await historicalMemoryContext(log, source, "old-5", model);
  const messages = input.units.flatMap((unit) => unit.messages);
  assert.deepEqual(messages.filter((message) => message.role === "user").map((message) => message.content),
    ["question-2", "question-3", "question-4", "question-5"]);
  const result = messages.find((message) => message.role === "toolResult");
  assert.ok(result?.role === "toolResult");
  assert.equal(result.toolCallId, "historical-call");
  assert.deepEqual(result.content, [{ type: "text", text: "EXACT FROZEN VIEW" }]);
  assert.deepEqual(result.details, { view: "bounded" });
  assert.doesNotMatch(JSON.stringify(messages), /RAW ORIGINAL DETAILS|FUTURE MUST NOT APPEAR/);
});

test("historical learning keeps four prior originals in a provisional Conversation range without future candidates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "historical-coverage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const model = getModel("openai", "gpt-4o-mini");
  const at = Date.parse("2026-01-01T00:00:00.000Z");
  for (let index = 0; index < 6; index++) {
    const requestId = `history-${index}`;
    const time = (offset: number) => new Date(at + index * 60_000 + offset).toISOString();
    await log.append({ type: "message", role: "user", chatId: 42, conversationId: "historical", requestId, text: `shared-topic original-${index}`, at: time(0) });
    await log.append({ type: "answer_generated", requestId, text: `settled-${index}`, at: time(100) });
    await log.append({ type: "delivery_succeeded", requestId, at: time(200) });
    await log.append({ type: "request_completed", requestId, at: time(300) });
  }
  const bootstrap = createMemoryBootstrap({ dataDir: dir, model });
  t.after(() => bootstrap.close());
  await bootstrap.start(log, 42);
  const learned = (await log.read()).filter((event) => event.type === "memory_learned" && event.origin === "historical");
  assert.deepEqual(learned.map((event) => event.requestId), ["history-0", "history-1", "history-2", "history-3", "history-4", "history-5"]);
  assert.deepEqual(learned[0]!.candidates, []);
  const last = learned.at(-1)!;
  assert.deepEqual((last.candidates as Array<{ nodeId: string }>).map((candidate) => candidate.nodeId),
    ["history-4", "history-3", "history-2", "history-1", "history-0"]);
  const shown = last.shown as Array<{ nodeId: string; existing: boolean }>;
  assert.deepEqual([...new Set(shown.filter((reference) => reference.existing).map((reference) => reference.nodeId))],
    ["history-4", "history-3", "history-2", "history-1"]);
  assert.deepEqual([...new Set(shown.filter((reference) => !reference.existing).map((reference) => reference.nodeId))], ["history-0"]);
});
