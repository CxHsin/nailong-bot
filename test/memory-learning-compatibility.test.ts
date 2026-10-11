import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelegramHostFixture } from "./fixtures/telegram-host.js";
import { createTestServer } from "./fixtures/http-server.js";
import { closeFixture } from "./fixtures/cleanup.js";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";
import { commitMemoryLearning } from "../src/application/memory-learning.js";
import { DEFAULT_DYNAMICS } from "../src/memory/dynamics.js";
import { memoryNodes } from "../src/runtime/memory-facts.js";

async function interruptedLearning(t: TestContext, strengthRate = 0.18) {
  const dir = await mkdtemp(join(tmpdir(), "memory-learning-compatibility-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "Be helpful.");
  const server = createTestServer(t, async (req, res) => {
    for await (const _chunk of req) { /* Actual Provider request. */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "delivered answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let shutdown = async () => {};
  t.after(() => closeFixture({ server, dir, shutdown: () => shutdown() }));
  const f = await createTelegramHostFixture(t, { agentOptions: { dataDir: dir, promptFile, memoryDynamics: { strengthRate },
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}`, model: "local", apiKey: "test" }] } },
    wrapLog: (log) => ({ ...log, append: async (event) => {
      if (event.type === "memory_learned") throw new Error("interrupted learning commit");
      return log.append(event);
    }, appendBatch: async (events) => {
      if (events.some((event) => event.type === "memory_learned")) throw new Error("interrupted learning commit");
      return log.appendBatch!(events);
    } }),
  });
  shutdown = () => f.close();
  await f.rootLog.append({ type: "message", requestId: "old-retry", chatId: 42, role: "user", text: "limboo" });
  await f.send("limboo");
  const facts = await f.rootLog.read();
  assert.ok(facts.some((event) => event.type === "delivery_succeeded"));
  assert.ok(facts.some((event) => event.type === "memory_presented"));
  assert.ok(facts.some((event) => event.type === "memory_degraded" && event.reason === "learning_unavailable"));
  assert.ok(!facts.some((event) => event.type === "memory_learned"));
  return f;
}

test("explicit recorded learning retry respects later exclusions and commits once; startup does not retry it", async (t) => {
  const f = await interruptedLearning(t);
  await f.rootLog.append({ type: "memory_excluded", nodeId: "old-retry" });
  await f.restart();
  assert.ok(!(await f.rootLog.read()).some((event) => event.type === "memory_learned"), "current startup promises no learning retry");
  await commitMemoryLearning(f.rootLog, 42);
  await commitMemoryLearning(f.rootLog, 42);
  const learning = (await f.rootLog.read()).filter((event) => event.type === "memory_learned");
  assert.equal(learning.length, 1);
  assert.deepEqual(learning[0]!.activated, []);
});

test("explicit learning retry uses recorded dynamics despite a different supplied configuration", async (t) => {
  const f = await interruptedLearning(t, 0.05);
  const before = (await f.rootLog.read()).findLast((event) => event.type === "memory_recalled")!;
  await commitMemoryLearning(f.rootLog, 42, { strengthRate: 0.8 });
  await commitMemoryLearning(f.rootLog, 42, { strengthRate: 0.8 });
  const learning = (await f.rootLog.read()).filter((event) => event.type === "memory_learned");
  assert.equal(learning.length, 1);
  assert.equal(learning[0]!.snapshotId, before.snapshotId);
  assert.equal((learning[0]!.dynamics as { strengthRate: number }).strengthRate, 0.05);
  assert.deepEqual((learning[0]!.activated as Array<{ nodeId: string }>).map((item) => item.nodeId), ["old-retry"]);
});

test("recorded old v2 delivered result qualifies for learning after request failure without a live v2 executor", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "memory-v2-learning-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir); // Historical writer shapes remain raw, independently of current runtime-v2 validation.
  await log.append({ type: "message", requestId: "old-partial", chatId: 42, role: "user", text: "limboo" });
  const old = memoryNodes(await log.read(), 42)[0]!;
  await log.append({ type: "message", requestId: "failed-stage", chatId: 42, role: "user", text: "limboo" });
  await log.append({ type: "memory_recalled", requestId: "failed-stage", snapshotId: "recorded-snapshot", dynamics: DEFAULT_DYNAMICS,
    candidates: [{ nodeId: old.id, score: 1 }] });
  await log.append({ type: "memory_presented", requestId: "failed-stage", snapshotId: "recorded-snapshot",
    shown: [{ nodeId: old.id, messageId: old.messages[0]!.id, offset: 0, end: 6 }] });
  await log.append({ type: "text_finalized", requestId: "failed-stage", textSegmentId: "old-result", contentKind: "result",
    protocolVersion: "json-text-v2", text: "已送达的阶段成果" });
  await log.append({ type: "telegram_page", requestId: "failed-stage", textSegmentId: "old-result", partIndex: 0, text: "已送达的阶段成果" });
  await log.append({ type: "telegram_plan_finalized", requestId: "failed-stage", textSegmentId: "old-result", parts: 1 });
  await log.append({ type: "telegram_delivery_succeeded", requestId: "failed-stage", textSegmentId: "old-result", partIndex: 0 });
  await log.append({ type: "request_failed", requestId: "failed-stage", error: "old Provider failure" });
  await commitMemoryLearning(log, 42); await commitMemoryLearning(log, 42);
  const events = await log.read();
  const learning = events.filter((event) => event.type === "memory_learned");
  assert.equal(learning.length, 1);
  assert.deepEqual((learning[0]!.activated as Array<{ nodeId: string }>).map((item) => item.nodeId), ["old-partial"]);
  assert.ok(events.some((event) => event.type === "request_failed"));
  assert.ok(!events.some((event) => event.type === "request_completed"));
});
