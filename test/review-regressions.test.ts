import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramProviderFixture as fixture, sendChatCompletion as output, checkWrites as guard } from "./fixtures/telegram-provider.js";

test("actual queued Telegram duplicates execute once across restart and reset", async (t) => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
  const { f, wire } = await fixture(t, async (res, requests) => { if (requests.length === 1) { started(); await gate; } output(res, "done"); });
  const first = f.send("same text", { messageId: 100 }); await ready;
  const duplicate = f.send("same text", { messageId: 100 });
  const queued = f.send("same text", { messageId: 101 });
  await f.accepted(); assert.equal(wire.length, 1);
  release(); await Promise.all([first, duplicate, queued]); assert.equal(wire.length, 2);
  await f.restart(); await f.send("/reset", { messageId: 102 });
  await f.send("same text", { messageId: 100 }); assert.equal(wire.length, 2);
  await f.send("same text", { messageId: 103 }); assert.equal(wire.length, 3);
  assert.equal((await f.rootLog.read()).filter((e) => e.type === "request_completed").length, 3);
});

test("replayed commands cannot reset newer context or overwrite a newer prompt", async (t) => {
  const { f, wire } = await fixture(t, (res) => output(res, "done"));
  await f.send("/reset", { messageId: 101 }); await f.send("/prompt set old-prompt", { messageId: 102 });
  await f.send("/prompt set new-prompt", { messageId: 103 }); await f.send("new-context", { messageId: 104 });
  await f.restart(); await f.send("/reset", { messageId: 101 }); await f.send("/prompt set old-prompt", { messageId: 102 });
  await f.send("continue", { messageId: 105 });
  const facts = await f.rootLog.read();
  assert.equal(facts.filter((e) => e.type === "conversation_reset").length, 1);
  assert.equal(facts.filter((e) => e.type === "bot_prompt_config").length, 2);
  assert.match(JSON.stringify(wire[1]), /new-prompt|new-context/); assert.doesNotMatch(JSON.stringify(wire[1]), /old-prompt/);
});

test("failed durable input submission suppresses Provider work and permits the same input to retry after restart", async (t) => {
  let fail = true;
  const { f, wire } = await fixture(t, (res) => output(res, "done"), { wrapLog: (log) => guard(log, (e) => { if (fail && e.type === "run_submitted") throw new Error("input commit failed"); }) });
  await f.send("retry input", { messageId: 100 });
  assert.equal(wire.length, 0); assert.deepEqual(await f.rootLog.read(), []);
  assert.ok(f.failures.some((e) => String(e).includes("input commit failed")));
  fail = false; await f.restart(); await f.send("retry input", { messageId: 100 });
  assert.equal(wire.length, 1); assert.ok(f.sent.includes("done"));
});
