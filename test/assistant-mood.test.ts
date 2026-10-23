import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

const moodCall = (inputId: string, request: string, mood: string, id: string, extra: Record<string, unknown> = {}) => [{
  index: 0, id, type: "function", function: { name: "persona_mood", arguments: JSON.stringify({ inputId, request, mood, ...extra }) },
}];

test("Assistant Service persists a source-backed mood and accepts an explicit calm correction", async () => {
  let stage = 0;
  const f = await assistantFixture((wire: Wire, response) => {
    stage++;
    if (stage === 1) sendChatCompletion(response, "", moodCall("mood-1", "我们终于把这件事做好了", "happy", "mood-happy"));
    else if (stage === 2) sendChatCompletion(response, "已记录当前心情。");
    else if (stage === 3) sendChatCompletion(response, "", moodCall("mood-2", "你不是开心，是有点累", "tired", "mood-correction", { source: "correction", clear: false }));
    else if (stage === 4) sendChatCompletion(response, "已按你的纠正调整。");
    else if (stage === 5) sendChatCompletion(response, "", moodCall("mood-3", "现在平稳了", "calm", "mood-clear", { clear: true }));
    else sendChatCompletion(response, "已回到平稳。");
  });
  try {
    assert.equal((await f.app.controlSnapshot("one")).mood.status, "calm");
    await f.app.receive({ conversationId: "one", inputId: "mood-1", text: "我们终于把这件事做好了" });
    await f.app.waitForIdle();
    const happy = (await f.app.controlSnapshot("one")).mood;
    assert.deepEqual({ state: happy.state, status: happy.status, source: happy.source }, {
      state: "happy", status: "active", source: { kind: "user_input", inputId: "mood-1" },
    });
    await f.reopen();
    assert.equal((await f.app.controlSnapshot("one")).mood.state, "happy");
    await f.app.receive({ conversationId: "one", inputId: "mood-2", text: "你不是开心，是有点累" });
    await f.app.waitForIdle();
    assert.deepEqual((await f.app.controlSnapshot("one")).mood, {
      state: "tired", label: "有点累", status: "active", source: { kind: "correction", inputId: "mood-2" }, sourceRefs: ["mood-2"], updatedAt: (await f.app.controlSnapshot("one")).mood.updatedAt,
    });
    await f.app.receive({ conversationId: "one", inputId: "mood-3", text: "现在平稳了" });
    await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).mood.status, "cleared");
    assert.equal((await f.app.controlSnapshot("one")).mood.state, "calm");
  } finally { await f.close(); }
});

test("historical or internal input identity cannot update mood", async () => {
  let calls = 0;
  const f = await assistantFixture((_wire, response) => {
    calls++;
    if (calls === 1) sendChatCompletion(response, "", moodCall("old-input", "引用旧话", "concerned", "mood-old"));
    else sendChatCompletion(response, "保持平稳。");
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "current", text: "请检查这段引用：引用旧话" });
    await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).mood.state, "calm");
  } finally { await f.close(); }
});

test("public mood update requires the active Processing Turn input", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await assistantFixture(async (_wire, response) => {
    entered();
    await held;
    sendChatCompletion(response, "已处理。");
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "active", text: "这轮让我有点好奇" });
    await started;
    const updated = f.app.updateMood("one", { mood: "curious", source: { kind: "user_input", inputId: "active" } });
    assert.equal(updated.accepted, true);
    assert.equal(updated.snapshot.state, "curious");
    assert.throws(() => f.app.updateMood("one", { mood: "happy", source: { kind: "user_input", inputId: "historical" } }), /本轮用户原话/);
    release();
    await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).mood.state, "curious");
  } finally { release(); await f.close(); }
});
