import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramRichTransport, isRichApiUnavailable } from "../src/channel/telegram/rich-transport.js";

const source = "# 标题\n\n**加粗**\n\n| 名称 | 值 |\n| --- | --- |\n| 一 | 二 |";

test("Rich transport sends original Markdown for drafts and final messages", async () => {
  const calls: Array<{ type: string; text: string }> = [];
  const transport = createTelegramRichTransport({
    sendRich: async (_chatId, markdown) => { calls.push({ type: "send-rich", text: markdown }); return 7; },
    draftRich: async (_draftId, _chatId, markdown) => { calls.push({ type: "draft-rich", text: markdown }); },
    sendHtml: async () => { throw new Error("HTML fallback should not run"); },
    draftHtml: async () => { throw new Error("HTML fallback should not run"); },
  });

  await transport.draft(3, source, 42);
  assert.equal(await transport.send(source, 42), 7);
  assert.deepEqual(calls, [
    { type: "draft-rich", text: source },
    { type: "send-rich", text: source },
  ]);
});

test("Rich transport falls back once after an unavailable method", async () => {
  const richCalls: string[] = [];
  const htmlCalls: Array<{ type: string; text: string }> = [];
  const unavailable = Object.assign(new Error("Not Found"), { error_code: 404 });
  const transport = createTelegramRichTransport({
    sendRich: async () => { richCalls.push("send"); throw unavailable; },
    draftRich: async () => { richCalls.push("draft"); throw unavailable; },
    sendHtml: async (_chatId, html) => { htmlCalls.push({ type: "send-html", text: html }); return 9; },
    draftHtml: async (_draftId, _chatId, html) => { htmlCalls.push({ type: "draft-html", text: html }); },
  });

  await transport.draft(3, source, 42);
  assert.equal(await transport.send(source, 42), 9);
  assert.equal(await transport.send(source, 42), 9);
  assert.deepEqual(richCalls, ["draft"]);
  assert.equal(htmlCalls[0]?.type, "draft-html");
  assert.equal(htmlCalls[1]?.type, "send-html");
  assert.equal(htmlCalls[2]?.type, "send-html");
  assert.match(htmlCalls[1]?.text ?? "", /<b>标题<\/b>/);
  assert.match(htmlCalls[1]?.text ?? "", /<b>1\.<\/b>/);
  assert.doesNotMatch(htmlCalls[1]?.text ?? "", /\*\*|\| 名称 \|/);
});

test("Rich final delivery falls back when only the final method is unavailable", async () => {
  let richCalls = 0;
  const html: string[] = [];
  const unavailable = Object.assign(new Error("Not Found"), { error_code: 404 });
  const transport = createTelegramRichTransport({
    sendRich: async () => { richCalls++; throw unavailable; },
    draftRich: async () => {},
    sendHtml: async (_chatId, text) => { html.push(text); return 11; },
    draftHtml: async () => {},
  });

  assert.equal(await transport.send(source, 42), 11);
  assert.equal(await transport.send(source, 42), 11);
  assert.equal(richCalls, 1);
  assert.equal(html.length, 2);
});

test("Rich transport does not downgrade content or rate-limit failures", async () => {
  let richCalls = 0;
  let htmlCalls = 0;
  const invalid = Object.assign(new Error("Bad Request: invalid markdown"), { error_code: 400 });
  const transport = createTelegramRichTransport({
    sendRich: async () => { richCalls++; throw invalid; },
    draftRich: async () => { throw invalid; },
    sendHtml: async () => { htmlCalls++; return 1; },
    draftHtml: async () => { htmlCalls++; },
  });

  await assert.rejects(() => transport.send(source, 42), invalid);
  await assert.rejects(() => transport.send(source, 42), invalid);
  assert.equal(richCalls, 2);
  assert.equal(htmlCalls, 0);
  assert.equal(isRichApiUnavailable(invalid), false);
  assert.equal(isRichApiUnavailable(Object.assign(new Error("Not Found"), { error_code: 404 })), true);
});

test("HTML fallback splits long Markdown into safe Telegram-sized messages", async () => {
  const chunks: string[] = [];
  const unavailable = Object.assign(new Error("Not Found"), { error_code: 404 });
  const transport = createTelegramRichTransport({
    sendRich: async () => { throw unavailable; },
    draftRich: async () => { throw unavailable; },
    sendHtml: async (_chatId, html) => { chunks.push(html); return chunks.length; },
    draftHtml: async () => {},
  });

  await transport.send("# 标题\n\n" + "内容。".repeat(1500), 42);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000));
  assert.ok(chunks.every((chunk) => !chunk.includes("##")));
});
