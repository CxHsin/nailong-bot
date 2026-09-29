import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createPiAgent } from "../src/pi-agent.js";
import { createSqliteRuntimeLog } from "../src/sqlite-runtime-log.js";
import { formatMarkdownForTelegram } from "../src/telegram-format.js";

test("short model deltas appear in readable Telegram updates", { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-cadence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const delta = "这是一段";
  const complete = delta.repeat(24);
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume model request. */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let index = 0; index < 24; index++) {
      res.write(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0,
        delta: { content: delta }, finish_reason: null }] })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0,
      delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => agent.close());
  const visible = new Map<number, string>();
  const modes: Array<string | undefined> = [];
  let sends = 0;
  let edits = 0;
  const app = createApp({ ownerId: 42, dataDir: dir, log, answer: agent.answer,
    send: async () => { throw new Error("answer must be finalized in place"); },
    telegram: {
      send: async (text, _chatId, mode) => { modes.push(mode); visible.set(++sends, text); return sends; },
      edit: async (messageId, text, _chatId, mode) => { modes.push(mode); edits++; visible.set(messageId, text); },
    },
  });
  await app.handle({ userId: 42, chatType: "private", text: "说明情况", messageId: 1 });
  assert.equal(sends, 1);
  assert.ok(edits <= 1, `too many small updates: ${edits}`);
  assert.equal(visible.get(1), complete);
  assert.ok(modes.every((mode) => mode === "HTML"));
  const snapshots = (await log.read()).filter((event) => event.type === "text_snapshot");
  assert.ok(snapshots.length <= 2, `too many durable fragments: ${snapshots.length}`);
});

test("Markdown is rendered as Telegram-safe HTML", () => {
  const html = formatMarkdownForTelegram("# 标题\n\n**加粗**、*斜体*、`代码`和[链接](https://example.com?q=1&x=2)\n\n- 第一项\n- 第二项");
  assert.match(html, /<b>标题<\/b>/);
  assert.match(html, /<b>加粗<\/b>/);
  assert.match(html, /<i>斜体<\/i>/);
  assert.match(html, /<code>代码<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\?q=1&amp;x=2">链接<\/a>/);
  assert.match(html, /• 第一项/);
  assert.match(html, /• 第二项/);
  assert.doesNotMatch(html, /<p>|<h1>|<ul>|<li>/);
});

test("unfinished Markdown and raw HTML cannot break Telegram markup", () => {
  const html = formatMarkdownForTelegram("正在输入 **强调 和 <script>坏内容</script>\n\n```ts\nconst x = 1");
  assert.doesNotMatch(html, /<script>|<p>|<h1>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<pre><code>/);
  assert.match(html, /const x = 1/);
});
