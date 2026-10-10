import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Api } from "grammy";
import { marked } from "marked";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";

const source = "# 标题\n\n**加粗**\n\n| 名称 | 值 |\n| --- | --- |\n| 一 | 二 |";

test("Rich transport sends identical Markdown for drafts, progress and final messages", async () => {
  const calls: Array<{ type: string; text: string }> = [];
  const transport = createTelegramRichTransport({
    sendRich: async (_chat, markdown) => { calls.push({ type: "send", text: markdown }); return 7; },
    draftRich: async (_id, _chat, markdown) => { calls.push({ type: "draft", text: markdown }); },
  });
  await transport.draft(3, source, 42);
  assert.equal(await transport.sendProgress(source, 42, "execution"), 7);
  assert.equal(await transport.send(source, 42), 7);
  assert.deepEqual(calls, [{ type: "draft", text: source }, { type: "send", text: source }, { type: "send", text: source }]);
});

for (const code of [400, 404, 429]) test(`Rich failures (${code}) never switch draft or formal output to HTML`, async () => {
  const error = { error_code: code, description: code === 400 ? "invalid markdown" : "Not Found" };
  const html: string[] = [];
  // Include the removed callbacks to prove even an older caller cannot activate them.
  const api = {
    sendRich: async () => { throw error; }, draftRich: async () => { throw error; },
    sendHtml: async (_chat: number, text: string) => { html.push(text); return 1; },
    draftHtml: async (_id: number, _chat: number, text: string) => { html.push(text); },
  };
  const transport = createTelegramRichTransport(api);
  await assert.rejects(transport.draft(1, source, 42), (value) => value === error);
  await assert.rejects(transport.send(source, 42), (value) => value === error);
  await assert.rejects(transport.sendPage(source, 42), (value) => value === error);
  assert.deepEqual(html, []);
});

test("Rich Markdown pagination retains long fenced code and Unicode without HTML", async () => {
  const sent: string[] = [];
  const transport = createTelegramRichTransport({ sendRich: async (_chat, text) => { sent.push(text); return sent.length; }, draftRich: async () => {} });
  const original = "```ts\n" + "const 家庭 = '👨‍👩‍👧‍👦';\n".repeat(500) + "```\n\n尾部结论";
  const pages = transport.plan({ id: "long", text: original, kind: "final" });
  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.length <= 3500));
  assert.ok(pages.every((page) => (page.match(/^```/gm) ?? []).length % 2 === 0));
  await transport.send(original, 42);
  assert.deepEqual(sent, pages);
  assert.equal(sent.join("").split("const 家庭").length - 1, 500);
  assert.equal(sent.join("").split("👨‍👩‍👧‍👦").length - 1, 500);
  assert.match(sent.at(-1)!, /尾部结论/);
  assert.doesNotMatch(sent.join(""), /<pre>|<blockquote>|<b>/);
});

test("native draft cancellation aborts grammY's actual HTTP request", async (t) => {
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const server = createServer(async (req, _res) => { for await (const _ of req) { /* drain */ } started(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const api = new Api("test-token", { apiRoot: `http://127.0.0.1:${address.port}` });
  const transport = createTelegramRichTransport({ sendRich: async () => 1,
    draftRich: async (id, chat, markdown, signal) => { await api.sendRichMessageDraft(chat, id, { markdown }, undefined, signal as Parameters<typeof api.sendRichMessageDraft>[4]); } });
  const controller = new AbortController();
  const draft = transport.draft(1, "正文", 42, controller.signal);
  await requestStarted; controller.abort();
  await assert.rejects(draft, { name: "AbortError" });
});

for (const container of ["list", "quote"]) test(`long fenced code remains code on every ${container} Markdown page`, () => {
  const transport = createTelegramRichTransport({ sendRich: async () => 1, draftRich: async () => {} });
  const code = "```ts\n" + "const 家庭 = '👨‍👩‍👧‍👦';\n".repeat(500) + "```\n";
  const source = container === "list" ? "- 步骤\n\n" + code.split("\n").map((line) => "  " + line).join("\n") : code.split("\n").map((line) => "> " + line).join("\n");
  const pages = transport.plan({ id: container, text: source, kind: "final" });
  assert.ok(pages.length > 1);
  let codeText = "";
  for (const page of pages) {
    assert.ok(page.length <= 3500);
    marked.walkTokens(marked.lexer(page), (token) => { if (token.type === "code") codeText += token.text; });
  }
  assert.equal(codeText.split("const 家庭").length - 1, 500);
  assert.equal(codeText.split("👨‍👩‍👧‍👦").length - 1, 500);
});

test("long bold text remains bold across native Markdown pages", () => {
  const transport = createTelegramRichTransport({ sendRich: async () => 1, draftRich: async () => {} });
  const body = "阶段结论。".repeat(1800);
  const pages = transport.plan({ id: "strong", text: `**${body}**`, kind: "progress" });
  let boldText = "";
  for (const page of pages) marked.walkTokens(marked.lexer(page), (token) => { if (token.type === "strong") boldText += token.text; });
  assert.equal(boldText, body);
});

test("a large combining grapheme after a preferred newline cannot overflow a Markdown page", () => {
  const transport = createTelegramRichTransport({ sendRich: async () => 1, draftRich: async () => {} });
  const grapheme = "x" + "\u0301".repeat(3298);
  const source = "```txt\n" + "a".repeat(1000) + "\n" + "b".repeat(700) + grapheme + "\n```";
  const pages = transport.plan({ id: "combining", text: source, kind: "final" });
  assert.ok(pages.every((page) => page.length <= 3500));
  assert.ok(pages.some((page) => page.includes(grapheme)));
  assert.equal(pages.join("").split("b").length - 1, 700);
});

test("oversized Rich drafts show the latest bounded Markdown page while formal delivery keeps all text", async () => {
  const drafts: Array<{ id: number; text: string }> = []; const sent: string[] = [];
  const transport = createTelegramRichTransport({
    sendRich: async (_chat, text) => { sent.push(text); return sent.length; },
    draftRich: async (id, _chat, text) => { assert.ok(text.length <= 32768); drafts.push({ id, text }); },
  });
  const prefix = "```ts\n" + "const 数据 = '😀';\n".repeat(2500);
  await transport.draft(2, prefix, 42);
  await transport.draft(2, prefix + "const 最新 = 42;\n```", 42);
  assert.deepEqual(drafts.map(({ id }) => id), [2, 2]);
  assert.match(drafts.at(-1)!.text, /const 最新 = 42;/);
  assert.equal(marked.lexer(drafts.at(-1)!.text)[0]?.type, "code");
  await transport.send(prefix + "const 最新 = 42;\n```", 42);
  assert.equal(sent.join("").split("const 数据").length - 1, 2500);
});
