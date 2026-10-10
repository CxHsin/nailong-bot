import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeLog, StoredEvent } from "../src/runtime/runtime-types.js";
import { activeContextStart } from "../src/runtime/history-scope.js";
import { createTelegramProviderFixture, sendChatCompletion } from "./fixtures/telegram-provider.js";

async function seedHistory(log: RuntimeLog, count = 6) {
  for (let index = 0; index < count; index++) {
    const requestId = `old-${index}`;
    const at = (offset: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + index * 60_000 + offset).toISOString();
    await log.append({ type: "message", role: "user", chatId: 42, text: `shared-topic detail-${index}`, requestId, at: at(0) });
    await log.append({ type: "answer_generated", text: `answer-${index}`, requestId, at: at(100) });
    await log.append({ type: "delivery_succeeded", requestId, at: at(200) });
    await log.append({ type: "request_completed", requestId, at: at(300) });
  }
}

function checkLearning(events: StoredEvent[], count: number) {
  const learned = events.filter((event) => event.type === "memory_learned" && event.origin === "historical");
  assert.equal(learned.length, count);
  assert.equal(new Set(learned.map((event) => event.requestId)).size, count);
  assert.ok(events.some((event) => event.type === "memory_bootstrap_completed"));
  assert.ok(!events.some((event) => event.type === "memory_degraded"));
  for (const learning of learned) {
    const terminal = events.find((event) => event.requestId === learning.requestId && event.type === "request_completed")!;
    assert.equal(learning.settledAt, terminal.at);
  }
}

test("historical initialization keeps synthetic starts ephemeral and online context survives restart", async (t) => {
  const { f, wire } = await createTelegramProviderFixture(t, (res) => sendChatCompletion(res, "healthy final"));
  await seedHistory(f.scopedLog);
  await f.agent.initializeMemory(f.scopedLog, 42);
  let events = await f.scopedLog.read();
  checkLearning(events, 6);
  assert.equal(events.filter((event) => event.type === "active_context_started").length, 0);
  // Scoped historical replay keeps four prior originals; older matching material is recalled separately.
  const last = events.find((event) => event.type === "memory_learned" && event.requestId === "old-5")!;
  const shown = last.shown as Array<{ nodeId: string; existing: boolean }>;
  assert.ok(shown.some((item) => item.nodeId === "old-0" && item.existing === false));
  for (const nodeId of ["old-1", "old-2", "old-3", "old-4"])
    assert.ok(shown.some((item) => item.nodeId === nodeId && item.existing === true));

  await f.send("new online question");
  assert.equal(wire.length, 1);
  const start = activeContextStart(await f.scopedLog.read());
  assert.ok(start);
  const beforeRestart = wire[0]!.messages;
  await f.restart();
  await f.agent.initializeMemory(f.scopedLog, 42);
  await f.send("new question after restart");
  events = await f.scopedLog.read();
  checkLearning(events, 6);
  assert.deepEqual(activeContextStart(events), start);
  assert.equal(events.filter((event) => event.type === "run_succeeded").length, 2);
  assert.ok(!events.some((event) => event.type === "run_failed"));
  assert.deepEqual(wire[1]!.messages.slice(0, beforeRestart.length), beforeRestart);
  assert.equal(f.sent.filter((text) => text === "healthy final").length, 2);
  assert.deepEqual(f.failures, []);
});

test("historical initialization preserves a valid online start after older unlearned turns", async (t) => {
  const { f, wire } = await createTelegramProviderFixture(t, (res) => sendChatCompletion(res, "healthy final"));
  await seedHistory(f.scopedLog, 2);
  await f.send("establish online start");
  const start = activeContextStart(await f.scopedLog.read());
  assert.ok(start);
  await f.agent.initializeMemory(f.scopedLog, 42);
  const events = await f.scopedLog.read();
  checkLearning(events, 2);
  assert.deepEqual(activeContextStart(events), start);
  assert.equal(events.filter((event) => event.type === "active_context_started").length, 1);
  await f.restart();
  await f.send("continue existing conversation");
  assert.equal(wire.length, 2);
  assert.deepEqual(activeContextStart(await f.scopedLog.read()), start);
  assert.deepEqual(f.failures, []);
});

test("default background initialization completes without replacing the online start", async (t) => {
  // Omit the production option rather than inheriting the fixture's isolation default (false).
  const { f, wire } = await createTelegramProviderFixture(t, (res) => sendChatCompletion(res, "healthy final"), {}, { memoryBootstrap: undefined });
  await seedHistory(f.scopedLog, 2);
  await f.send("start default bootstrap");
  const start = activeContextStart(await f.scopedLog.read());
  assert.ok(start);
  const deadline = performance.now() + 5000;
  while (!(await f.scopedLog.read()).some((event) => event.type === "memory_bootstrap_completed") && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const events = await f.scopedLog.read();
  checkLearning(events, 2);
  assert.deepEqual(activeContextStart(events), start);
  await f.restart();
  await f.send("continue after default bootstrap restart");
  assert.equal(wire.length, 2);
  assert.deepEqual(activeContextStart(await f.scopedLog.read()), start);
  assert.deepEqual(f.failures, []);
});
