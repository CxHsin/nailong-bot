import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantState } from "../src/assistant/state.js";
import { PersistentAssistantQueue } from "../src/assistant/queue.js";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { controlPanelFixture } from "./fixtures/control-panel.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

const toolCall = (response: Parameters<typeof sendChatCompletion>[0], name: string, args: object, id: string) =>
  sendChatCompletion(response, "", [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]);
const latestUser = (wire: Wire) => wire.messages.filter(message => message.role === "user").at(-1);
const latestPanel = (fixture: { sent: Array<{ method: string; body: unknown }> }) => {
  const message = fixture.sent.filter(item => item.method === "sendMessage" || item.method === "editMessageText").at(-1);
  return JSON.parse(String(message?.body)) as { text?: string; reply_markup?: { inline_keyboard: Array<Array<{ text: string }>> } };
};
const update = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: 0,
  chat: { id: 42, type: "private" as const, first_name: "owner" }, from: { id: 42, is_bot: false, first_name: "owner" }, text } });

/** The first-release seam: one durable service turn carries continuity, responsibility and corrigible mood. */
test("first-release service path keeps experience, work identity and mood separate across reset/restart", { timeout: 20000 }, async () => {
  const requests: Wire[] = [];
  let moodStage: "happy" | "tired" | "calm" | undefined;
  const f = await assistantFixture((wire, response) => {
    requests.push(wire);
    const text = JSON.stringify(latestUser(wire)?.content ?? "");
    if (text.includes("记住月桥") && wire.messages.at(-1)?.role === "user") {
      toolCall(response, "memory_write", { action: "add", kind: "MEMORY", content: "共同经历：在月桥喝过白茶", quote: "月桥喝过白茶", expectedVersion: 0 }, "remember-bridge");
    } else if (text.includes("终于完成") && wire.messages.at(-1)?.role === "user") {
      moodStage = "happy";
      toolCall(response, "persona_mood", { inputId: "mood-happy", request: "我们终于完成了这项工作", mood: "happy" }, "mood-happy");
    } else if (text.includes("你不是开心") && wire.messages.at(-1)?.role === "user") {
      moodStage = "tired";
      toolCall(response, "persona_mood", { inputId: "mood-correction", request: "你不是开心，是有点累", mood: "tired", source: "correction" }, "mood-correction");
    } else if (text.includes("回到平稳") && wire.messages.at(-1)?.role === "user") {
      moodStage = "calm";
      toolCall(response, "persona_mood", { inputId: "mood-clear", request: "现在回到平稳", mood: "calm", clear: true }, "mood-clear");
    } else sendChatCompletion(response, "已处理。");
  }, async (cwd) => {
    const dataDir = join(cwd, "fresh");
    await mkdir(dataDir, { recursive: true });
    const queue = new PersistentAssistantQueue(join(dataDir, "queue.sqlite"));
    const state = new AssistantState(dataDir);
    try {
      queue.receive({ conversationId: "one", inputId: "accepted-work", text: "准备月桥发布说明" });
      const work = queue.listWorks("one").find(item => item.inputId === "accepted-work")!;
      queue.settle(queue.claim("one")!.id, "completed");
      state.saveHelpers("one", [{ id: "helper-coder-1", session: "fixture", agent: "coder", paneId: "coder:p1", workspaceId: "workspace-1", cwd,
        promptPath: join(cwd, "helper-prompt.txt"), sequence: 1, delivered: false, targetIds: [work.id], summary: "准备月桥发布说明" }]);
    } finally { state.close(); queue.close(); }
    return {};
  });
  try {
    await f.app.control("one", { type: "expression", frequency: "quiet", operationId: "quiet-before-mood" });
    await f.app.control("one", { type: "feed", operationId: "feed-before-mood" });
    const independentBefore = await f.app.controlSnapshot("one");
    await f.app.receive({ conversationId: "one", inputId: "remember-bridge", text: "记住月桥喝过白茶，这是我们的共同经历" });
    await f.app.waitForIdle();
    await f.app.receive({ conversationId: "one", inputId: "mood-happy", text: "我们终于完成了这项工作" });
    await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).mood.state, "happy");

    await f.app.control("one", { type: "reset", operationId: "acceptance-reset" });
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "continue-bridge", text: "月桥那次共同经历后来怎样了？" });
    await f.app.waitForIdle();
    const continuation = JSON.stringify(requests.at(-1));
    assert.match(continuation, /共同经历：在月桥喝过白茶/);
    assert.match(continuation, /纯真善意/);
    assert.match(continuation, /乐观好奇/);
    assert.doesNotMatch(continuation, /固定.*傲娇/);

    const afterRestart = await f.app.controlSnapshot("one");
    assert.equal(afterRestart.mood.state, "happy");
    assert.equal(afterRestart.expressionFrequency, independentBefore.expressionFrequency);
    assert.equal(afterRestart.satiety.label, independentBefore.satiety.label);
    assert.ok(Math.abs(afterRestart.satiety.value - independentBefore.satiety.value) < 0.01);
    const helperWork = afterRestart.works.find(work => work.helperId === "helper-coder-1");
    assert.equal(helperWork?.summary, "准备月桥发布说明");
    assert.equal(helperWork?.status, "helper");

    await f.app.receive({ conversationId: "one", inputId: "mood-correction", text: "你不是开心，是有点累" });
    await f.app.waitForIdle();
    assert.equal(moodStage, "tired");
    assert.equal((await f.app.controlSnapshot("one")).mood.source?.kind, "correction");
    await f.app.receive({ conversationId: "one", inputId: "mood-clear", text: "现在回到平稳" });
    await f.app.waitForIdle();
    const cleared = await f.app.controlSnapshot("one");
    assert.equal(cleared.mood.status, "cleared");
    assert.equal(cleared.mood.state, "calm");
    assert.equal(cleared.expressionFrequency, independentBefore.expressionFrequency);
    assert.equal(cleared.satiety.label, independentBefore.satiety.label);
    assert.ok(Math.abs(cleared.satiety.value - independentBefore.satiety.value) < 0.01);
    assert.equal(cleared.works.find(work => work.helperId === "helper-coder-1")?.status, "helper");
  } finally { await f.close(); }
});

/** Telegram only renders the persisted control snapshot; opening it never creates a model turn. */
test("first-release Telegram path shows mood beside independent persona state and stays read-only after restart", { timeout: 20000 }, async () => {
  const f = await controlPanelFixture({ provider: (_wire, response) => {
    if (f.requests.length === 1) toolCall(response, "persona_mood", { inputId: "7002", request: "这次终于完成了", mood: "happy" }, "telegram-mood");
    else sendChatCompletion(response, "已记录。");
  }});
  try {
    await f.bot.handleUpdate(update(7001, "/start"));
    const calm = latestPanel(f);
    assert.match(calm.text ?? "", /情绪：平稳/);
    assert.match(calm.text ?? "", /暂无特别变化/);
    assert.equal(f.requests.length, 0);
    const before = await f.app.controlSnapshot("telegram:private:42");
    await f.app.control("telegram:private:42", { type: "expression", frequency: "restrained", operationId: "telegram-expression" });
    await f.app.control("telegram:private:42", { type: "feed", operationId: "telegram-feed" });
    await f.bot.handleUpdate(update(7002, "这次终于完成了"));
    await f.flush();
    const active = await f.app.controlSnapshot("telegram:private:42");
    assert.equal(active.mood.state, "happy");
    assert.equal(active.expressionFrequency, "restrained");
    assert.equal(active.satiety.label, before.satiety.label);
    const requestsBeforeStart = f.requests.length;
    const outputsBeforeStart = f.outputs.length;
    await f.bot.handleUpdate(update(7003, "/start"));
    const panel = latestPanel(f);
    assert.match(panel.text ?? "", /情绪：开心/);
    assert.equal(f.requests.length, requestsBeforeStart);
    assert.equal(f.outputs.length, outputsBeforeStart);
    assert.equal((await f.app.controlSnapshot("telegram:private:42")).mood.state, "happy");

    await f.reopen();
    await f.bot.handleUpdate(update(7004, "/start"));
    const restarted = latestPanel(f);
    assert.match(restarted.text ?? "", /情绪：开心/);
    assert.match(restarted.reply_markup?.inline_keyboard.flat().map(button => button.text).join(" ") ?? "", /饱食/);
    assert.equal(f.requests.length, requestsBeforeStart);
    assert.equal((await f.app.controlSnapshot("telegram:private:42")).expressionFrequency, "restrained");
    assert.equal((await f.app.controlSnapshot("telegram:private:42")).satiety.label, active.satiety.label);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
