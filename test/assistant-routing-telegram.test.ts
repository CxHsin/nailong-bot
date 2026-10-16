import { test } from "node:test";
import assert from "node:assert/strict";
import { Bot } from "grammy";
import { Response as ApiResponse } from "node-fetch";
import { connectTelegram } from "../src/assistant/telegram.js";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

const conversationId = "telegram:private:42";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPfoAAAAASUVORK5CYII=";
const botInfo = { id: 1, is_bot: true as const, first_name: "test", username: "test_bot", can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
  can_manage_bots: false, supports_join_request_queries: false };
type Snapshot = { current: { inputId: string; text: string; hasImages: boolean }; replyTargets: string[];
  works: Array<{ id: string; inputId: string; summary: string }>; recent: Array<{ role: string; text: string }> };

function update(id: number, options: { text?: string; photo?: boolean; reply?: number } = {}) {
  const original = { message_id: options.reply ?? 0, date: 0, chat: { id: 42, type: "private" as const, first_name: "owner" },
    from: { id: 42, is_bot: false, first_name: "owner" }, text: "original message", reply_to_message: undefined };
  return { update_id: id, message: { ...original, message_id: id,
    ...(options.photo ? { text: undefined, caption: options.text, photo: [{ file_id: "photo", file_unique_id: "photo", width: 1, height: 1 }] } : { text: options.text ?? "hello" }),
    ...(options.reply === undefined ? {} : { reply_to_message: original }),
  } };
}

async function telegramRouterFixture(split = false) {
  const snapshots: Snapshot[] = []; const main: Wire[] = [];
  const f = await assistantFixture((wire, response) => {
    if ((wire as Wire & { model: string }).model === "router") {
      const snapshot = JSON.parse(String(wire.messages.at(-1)!.content)) as Snapshot;
      snapshots.push(snapshot);
      const text = snapshot.current.text;
      const actions = split && text === "generate report; check weather" ? [{ kind: "request", text: "generate report" }, { kind: "request", text: "check weather" }] : [{ kind: "request", text }];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ actions }) }, finish_reason: "stop" }] }));
    } else { main.push(wire); sendChatCompletion(response, `confirmed answer ${main.length}`); }
  }, async () => ({ intent: { model: "router" }, modelConfiguration: { defaultModel: "local", models: [
    { alias: "local", model: "local", api: "openai-completions", apiKey: "test", baseUrl: "" },
    { alias: "router", model: "router", api: "openai-completions", apiKey: "test", baseUrl: "" },
  ] } }));
  let nextMessage = 1000;
  const sent: Array<{ method: string; messageId: number }> = []; const errors: unknown[] = [];
  const bot = new Bot("test", { botInfo, client: { fetch: async (url) => {
    const method = String(url).split("/").at(-1)!; const messageId = ++nextMessage;
    sent.push({ method, messageId });
    return new ApiResponse(JSON.stringify({ ok: true, result: { message_id: messageId, date: 0, chat: { id: 42, type: "private" } } }), { headers: { "content-type": "application/json" } });
  } } });
  const channel = await connectTelegram({ app: f.app, bot, ownerId: 42, dataDir: f.directory,
    download: async () => ({ type: "image", mimeType: "image/png", data: png }), reportFailure: (error) => { errors.push(error); } });
  return { ...f, bot, snapshots, main, sent, errors,
    async flush() { await channel.finish(); await f.app.waitForRouting(); await f.app.waitForIdle(); },
    async close() { await channel.close(); await f.close(); },
  };
}

test("Telegram replies to an original user message provide its actual work identity to the classifier", async () => {
  const f = await telegramRouterFixture();
  try {
    await f.bot.handleUpdate(update(11, { text: "generate report" })); await f.flush();
    await f.bot.handleUpdate(update(12, { text: "change report to CSV", reply: 11 })); await f.flush();
    const snapshot = f.snapshots.find((entry) => entry.current.inputId === "12")!;
    const original = snapshot.works.filter((work) => work.inputId === "11");
    assert.equal(original.length, 1); assert.deepEqual(snapshot.replyTargets, original.map((work) => work.id));
    assert.equal(snapshot.current.text, "change report to CSV"); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Telegram replies to a sent multi-target answer retain every original target and unknown replies invent none", async () => {
  const f = await telegramRouterFixture(true);
  try {
    await f.bot.handleUpdate(update(21, { text: "generate report; check weather" })); await f.flush();
    const answer = f.sent.find((entry) => entry.method === "sendRichMessage"); assert.ok(answer);
    await f.bot.handleUpdate(update(22, { text: "which work did that answer cover?", reply: answer.messageId })); await f.flush();
    const snapshot = f.snapshots.find((entry) => entry.current.inputId === "22")!;
    const original = snapshot.works.filter((work) => work.inputId === "21");
    assert.equal(original.length, 2);
    assert.deepEqual(new Set(snapshot.replyTargets), new Set(original.map((work) => work.id)));
    await f.bot.handleUpdate(update(23, { text: "what was that?", reply: 999999 })); await f.flush();
    assert.deepEqual(f.snapshots.find((entry) => entry.current.inputId === "23")!.replyTargets, []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("a Telegram photo without a caption bypasses text classification and preserves the original image for the main assistant", async () => {
  const f = await telegramRouterFixture();
  try {
    await f.bot.handleUpdate(update(31, { photo: true })); await f.flush();
    assert.equal(f.snapshots.length, 0);
    assert.equal(f.main.length, 1);
    assert.match(JSON.stringify(f.main[0]!.messages), /data:image\/png;base64/);
    assert.ok(JSON.stringify(f.main[0]!.messages).includes(png));
    assert.match(JSON.stringify(f.main[0]!.messages), /needs_visual/);
    const work = f.app.routingStatus(conversationId).works.find((entry) => entry.inputId === "31");
    assert.equal(work?.input.userText, "");
    assert.equal(work?.input.text, "请分析这张图片。");
    const textParts = f.main[0]!.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part: {type?: string}) => part.type === "text").map((part: {text: string}) => part.text) : typeof message.content === "string" ? [message.content] : []);
    const event = textParts.find((text: string) => text.startsWith('<event identity="31"'));
    assert.ok(event);
    assert.match(event, />\n\n<\/event>$/);
    assert.ok(textParts.some((text: string) => text.startsWith('<routing-material identity="31"') && text.includes("通道提示") && text.includes("请分析这张图片。")));
    assert.ok(!textParts.some((text: string) => /原文：请分析这张图片。/.test(text)));
    await f.bot.handleUpdate(update(32, { text: "继续看刚才的图片" })); await f.flush();
    const recent = f.snapshots.find((snapshot) => snapshot.current.inputId === "32")!.recent;
    assert.ok(!recent.some((entry) => entry.role === "user" && entry.text.includes("请分析这张图片。")));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("a Telegram photo caption can independently classify while the main assistant still receives the image", async () => {
  const f = await telegramRouterFixture();
  try {
    await f.bot.handleUpdate(update(41, { photo: true, text: "explain this photo" })); await f.flush();
    assert.equal(f.snapshots.length, 1);
    assert.equal(f.snapshots[0]!.current.text, "explain this photo");
    assert.equal(f.snapshots[0]!.current.hasImages, true);
    assert.ok(!JSON.stringify(f.snapshots[0]).includes(png));
    assert.match(JSON.stringify(f.main[0]!.messages), /data:image\/png;base64/);
    assert.match(JSON.stringify(f.main[0]!.messages), /explain this photo/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("classifier recent turns include confirmed assistant text and reset excludes the prior chat", async () => {
  const f = await telegramRouterFixture();
  try {
    await f.bot.handleUpdate(update(51, { text: "OLD_VISIBLE discuss report" })); await f.flush();
    await f.bot.handleUpdate(update(52, { text: "follow up on report" })); await f.flush();
    const before = f.snapshots.find((entry) => entry.current.inputId === "52")!;
    assert.ok(before.recent.some((entry) => entry.role === "user" && entry.text.includes("OLD_VISIBLE")));
    assert.ok(before.recent.some((entry) => entry.role === "assistant" && entry.text.includes("confirmed answer 1")));
    await f.bot.handleUpdate(update(53, { text: "/reset" })); await f.flush();
    await f.bot.handleUpdate(update(54, { text: "NEW_VISIBLE discuss weather" })); await f.flush();
    const after = f.snapshots.find((entry) => entry.current.inputId === "54")!;
    assert.doesNotMatch(JSON.stringify(after.recent), /OLD_VISIBLE|follow up on report|confirmed answer [12]/);
    assert.doesNotMatch(JSON.stringify(after), /OLD_VISIBLE|follow up on report|confirmed answer [12]/);
    assert.equal(f.snapshots.some((entry) => entry.current.inputId === "53"), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
