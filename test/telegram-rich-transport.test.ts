import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Api } from "grammy";
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

test("draft cancellation reaches Rich and HTML APIs and cannot start a fallback after abort", async () => {
  const unavailable = Object.assign(new Error("Not Found"), { error_code: 404 });
  const controller = new AbortController();
  const signals: Array<AbortSignal | undefined> = [];
  const transport = createTelegramRichTransport({
    sendRich: async () => 1, sendHtml: async () => 1,
    draftRich: async (_id, _chat, _text, signal) => { signals.push(signal); throw unavailable; },
    draftHtml: async (_id, _chat, _text, signal) => { signals.push(signal); },
  });
  await transport.draft(1, "正文", 42, controller.signal);
  assert.deepEqual(signals, [controller.signal, controller.signal]);
  controller.abort();
  await assert.rejects(transport.draft(1, "正文", 42, controller.signal), { name: "AbortError" });
  assert.equal(signals.length, 2);
  const pending = new AbortController();
  let htmlCalls = 0;
  const aborted = createTelegramRichTransport({
    sendRich: async () => 1, sendHtml: async () => 1,
    draftRich: async () => { pending.abort(); throw unavailable; },
    draftHtml: async () => { htmlCalls++; },
  });
  await assert.rejects(aborted.draft(1, "正文", 42, pending.signal), { name: "AbortError" });
  assert.equal(htmlCalls, 0);
});

test("native draft cancellation aborts grammY's actual HTTP request", async (t) => {
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const server = createServer(async (req, _res) => {
    for await (const _ of req) { /* drain */ }
    started(); // Deliberately leave the local HTTP response pending.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const api = new Api("test-token", { apiRoot: `http://127.0.0.1:${address.port}` });
  const transport = createTelegramRichTransport({
    sendRich: async () => 1, sendHtml: async () => 1, draftHtml: async () => { throw new Error("no fallback after abort"); },
    draftRich: async (id, chat, markdown, signal) => {
      await api.sendRichMessageDraft(chat, id, { markdown }, undefined, signal as Parameters<typeof api.sendRichMessageDraft>[4]);
    },
  });
  const controller = new AbortController();
  const draft = transport.draft(1, "正文", 42, controller.signal);
  await requestStarted;
  controller.abort();
  await assert.rejects(draft, { name: "AbortError" });
});
