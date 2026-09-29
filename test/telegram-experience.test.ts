import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp, DeliveryRejected } from "../src/app.js";
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
  const updates: string[] = [];
  const modes: Array<string | undefined> = [];
  let sends = 0;
  let edits = 0;
  const app = createApp({ ownerId: 42, dataDir: dir, log, answer: agent.answer,
    send: async () => { throw new Error("answer must be finalized in place"); },
    telegram: {
      send: async (text, _chatId, mode) => { modes.push(mode); visible.set(++sends, text);
        updates.push(text); return sends; },
      edit: async (messageId, text, _chatId, mode) => { modes.push(mode); edits++; visible.set(messageId, text);
        updates.push(text); },
    },
  });
  await app.handle({ userId: 42, chatType: "private", text: "说明情况", messageId: 1 });
  assert.equal(sends, 1);
  assert.ok(updates.length >= 4, `reply did not visibly progress: ${updates.length}`);
  assert.ok(updates[0]!.length <= 12, `first fragment was delayed: ${updates[0]!.length}`);
  assert.ok(updates.every((item, index) => index === 0 || item.length > updates[index - 1]!.length));
  assert.ok(edits < complete.length, `an edit was made for every character: ${edits}`);
  assert.equal(visible.get(1), complete);
  assert.ok(modes.every((mode) => mode === "HTML"));
});

test("Telegram native draft animates selected text and final answer becomes a lasting message", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-native-draft-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const drafts: Array<{ id: number; text: string; mode?: string }> = [];
  const sent: string[] = [];
  let edits = 0;
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      for (const text of ["你", "你好", "你好，世界"]) {
        await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "native",
          contentKind: "provisional", text });
        await request.onText?.("native");
        await new Promise((resolve) => setTimeout(resolve, 230));
      }
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "native",
        contentKind: "final", text: "你好，世界" });
      await request.onText?.("native");
      return "你好，世界";
    },
    send: async () => { throw new Error("must persist through projection"); },
    telegram: {
      draft: async (id, text, _chatId, mode) => { drafts.push({ id, text, mode }); },
      send: async (text) => { sent.push(text); return 1; },
      edit: async () => { edits++; },
    },
  });
  await app.handle({ userId: 42, chatType: "private", text: "打招呼", messageId: 1 });
  assert.ok(drafts.length >= 2);
  assert.ok(drafts.every((draft) => draft.id === drafts[0]!.id && draft.mode === "HTML"));
  assert.equal(drafts.at(-1)!.text, "你好，世界");
  assert.deepEqual(sent, ["你好，世界"]);
  assert.equal(edits, 0);
});

test("a rejected native draft still delivers the lasting final answer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-draft-rejected-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const sent: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "rejected-draft",
        contentKind: "provisional", text: "完整回复" });
      await request.onText?.("rejected-draft");
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "rejected-draft",
        contentKind: "final", text: "完整回复" });
      await request.onText?.("rejected-draft");
      return "完整回复";
    },
    send: async () => { throw new Error("must persist through projection"); },
    telegram: {
      draft: async () => { throw new DeliveryRejected("draft unavailable"); },
      send: async (text) => { sent.push(text); return 1; },
      edit: async () => undefined,
      isRejected: (error) => error instanceof DeliveryRejected,
    },
  });
  await app.handle({ userId: 42, chatType: "private", text: "回复", messageId: 1 });
  assert.deepEqual(sent, ["完整回复"]);
  assert.equal((await log.read()).some((event) => event.type === "delivery_succeeded"), true);
});

test("a new user message completes the older visible reply", { timeout: 15_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-interrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const full = "逐".repeat(80);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const visible: string[] = [];
  let turns = 0;
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      if (++turns === 2) return "新回复";
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "old",
        contentKind: "provisional", text: "逐字开始" });
      await request.onText?.("old");
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "old",
        contentKind: "provisional", text: full });
      await request.onText?.("old");
      await gate;
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "old",
        contentKind: "final", text: full });
      await request.onText?.("old");
      return full;
    },
    send: async () => undefined,
    telegram: {
      send: async (text) => { visible.push(text); return 1; },
      edit: async (_id, text) => { visible.push(text); },
    },
  });
  let firstStarted = false;
  let secondStarted = false;
  const first = app.handle({ userId: 42, chatType: "private", text: "第一条", messageId: 1 },
    () => { firstStarted = true; });
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(predicate(), "Telegram update did not arrive");
  };
  await until(() => visible.length > 0);
  assert.equal(firstStarted, true, "polling should be released while the first reply is running");
  assert.notEqual(visible.at(-1), full);
  const second = app.handle({ userId: 42, chatType: "private", text: "第二条", messageId: 2 },
    () => { secondStarted = true; });
  await until(() => visible.at(-1) === full);
  assert.equal(secondStarted, false, "queued inputs must not be acknowledged before execution starts");
  release();
  await Promise.all([first, second]);
  assert.equal(secondStarted, true);
});

test("a failed model turn stops an unfinished typing animation", { timeout: 5_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-abort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const messages: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "partial",
        contentKind: "provisional", text: "正在回答" });
      await request.onText?.("partial");
      throw new Error("provider failed");
    },
    send: async (text) => { messages.push(text); },
    telegram: { send: async () => 1, edit: async () => undefined },
  });
  await app.handle({ userId: 42, chatType: "private", text: "问题", messageId: 1 });
  assert.match(messages.at(-1) ?? "", /抱歉/);
});

test("a rate limited edit waits before completing the final reply", { timeout: 12_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-rate-limit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const complete = "限".repeat(180);
  let firstSent!: () => void;
  const sent = new Promise<void>((resolve) => { firstSent = resolve; });
  let rejectedAt = 0;
  let retriedAt = 0;
  let visible = "";
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "limited",
        contentKind: "provisional", text: "限" });
      await request.onText?.("limited");
      await sent;
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "limited",
        contentKind: "provisional", text: complete });
      await request.onText?.("limited");
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "limited",
        contentKind: "final", text: complete });
      await request.onText?.("limited");
      return complete;
    },
    send: async () => { throw new Error("must finalize in place"); },
    telegram: {
      send: async (text) => { visible = text; firstSent(); return 1; },
      edit: async (_id, text) => {
        if (!rejectedAt) {
          rejectedAt = Date.now();
          throw new DeliveryRejected("retry later", 1500);
        }
        if (!retriedAt) retriedAt = Date.now();
        visible = text;
      },
      isRejected: (error) => error instanceof DeliveryRejected,
      retryAfter: (error) => error instanceof DeliveryRejected ? error.retryAfterMs : undefined,
    },
  });
  await app.handle({ userId: 42, chatType: "private", text: "测试限流", messageId: 1 });
  assert.ok(retriedAt - rejectedAt >= 1500, "Telegram retry_after was ignored");
  assert.equal(visible, complete);
});

test("a large completed reply starts small and catches up within three seconds", { timeout: 12_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-catch-up-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const complete = "好".repeat(600);
  const updates: Array<{ text: string; at: number }> = [];
  let finalizedAt = 0;
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "large",
        contentKind: "provisional", text: complete });
      await request.onText?.("large");
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "large",
        contentKind: "final", text: complete });
      finalizedAt = Date.now();
      await request.onText?.("large");
      return complete;
    },
    send: async () => { throw new Error("must finalize in place"); },
    telegram: {
      send: async (text) => { updates.push({ text, at: Date.now() }); return 1; },
      edit: async (_id, text) => { updates.push({ text, at: Date.now() }); },
    },
  });
  await app.handle({ userId: 42, chatType: "private", text: "长回答", messageId: 1 });
  assert.ok(updates[0]!.text.length <= 12);
  assert.ok(updates.some((update) => update.text.length > 30 && update.text.length < complete.length));
  assert.equal(updates.at(-1)!.text, complete);
  // Allow a scheduling/transport margin around the three-second presentation bound.
  assert.ok(updates.at(-1)!.at - finalizedAt < 3700);
});

test("an opening code fence waits for visible content instead of sending an empty message", { timeout: 8_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-first-markdown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const complete = "```typescript\nconst value = 1;\n```";
  const messages: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "code",
        contentKind: "provisional", text: "```typescript\n" });
      await request.onText?.("code");
      await new Promise((resolve) => setTimeout(resolve, 650));
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "code",
        contentKind: "provisional", text: complete });
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "code",
        contentKind: "final", text: complete });
      await request.onText?.("code");
      return complete;
    },
    send: async () => { throw new Error("must finalize in place"); },
    telegram: {
      send: async (text) => {
        assert.ok(text.replace(/<[^>]+>/g, "").trim(), "empty Telegram message attempted");
        messages.push(text); return 1;
      },
      edit: async (_id, text) => { messages.push(text); },
      isRejected: () => true,
    },
  });
  await app.handle({ userId: 42, chatType: "private", text: "代码", messageId: 1 });
  assert.equal(messages.at(-1), formatMarkdownForTelegram(complete));
});

test("repeated rate limits do not hold the request queue forever", { timeout: 12_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-repeat-limit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const complete = "后续文字".repeat(30);
  let firstSent!: () => void;
  const sent = new Promise<void>((resolve) => { firstSent = resolve; });
  let limited = true;
  const unblock = setTimeout(() => { limited = false; }, 5500);
  t.after(() => clearTimeout(unblock));
  let turns = 0;
  const notices: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      if (++turns > 1) return "新回复";
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "repeat",
        contentKind: "provisional", text: "后续" });
      await request.onText?.("repeat");
      await sent;
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "repeat",
        contentKind: "provisional", text: complete });
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "repeat",
        contentKind: "final", text: complete });
      await request.onText?.("repeat");
      return complete;
    },
    send: async (text) => { notices.push(text); },
    telegram: {
      send: async () => { firstSent(); return 1; },
      edit: async () => { if (limited) throw new DeliveryRejected("rate limited", 250); },
      isRejected: (error) => error instanceof DeliveryRejected,
      retryAfter: (error) => error instanceof DeliveryRejected ? error.retryAfterMs : undefined,
    },
  });
  const startedAt = Date.now();
  await app.handle({ userId: 42, chatType: "private", text: "测试", messageId: 1 });
  await app.handle({ userId: 42, chatType: "private", text: "继续", messageId: 2 });
  assert.ok(Date.now() - startedAt < 5000, "repeated limits kept the request queue blocked");
  assert.equal(notices.at(-1), "新回复");
});

test("a long retry-after does not hold the request queue past the finish grace", { timeout: 8_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-long-limit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  let firstSent!: () => void;
  const sent = new Promise<void>((resolve) => { firstSent = resolve; });
  let edits = 0;
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "long-limit",
        contentKind: "provisional", text: "开" });
      await request.onText?.("long-limit");
      await sent;
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "long-limit",
        contentKind: "provisional", text: "开始以后还有很多文字" });
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "long-limit",
        contentKind: "final", text: "开始以后还有很多文字" });
      await request.onText?.("long-limit");
      return "开始以后还有很多文字";
    },
    send: async () => undefined,
    telegram: {
      send: async () => { firstSent(); return 1; },
      edit: async () => { edits++; throw new DeliveryRejected("rate limited", 10000); },
      isRejected: (error) => error instanceof DeliveryRejected,
      retryAfter: (error) => error instanceof DeliveryRejected ? error.retryAfterMs : undefined,
    },
  });
  const startedAt = Date.now();
  await app.handle({ userId: 42, chatType: "private", text: "测试", messageId: 1 });
  assert.ok(Date.now() - startedAt < 4500, "long retry-after held the request queue");
  assert.equal(edits, 1);
  assert.equal((await log.read()).some((event) => event.type === "delivery_succeeded"), false);
});

test("ordinary text advances at a readable typing rate", { timeout: 8_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-typing-rate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const complete = "字".repeat(60);
  const updates: Array<{ text: string; at: number }> = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "paced",
        contentKind: "provisional", text: complete });
      await request.onText?.("paced");
      await new Promise((resolve) => setTimeout(resolve, 1700));
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "paced",
        contentKind: "final", text: complete });
      await request.onText?.("paced");
      return complete;
    },
    send: async () => { throw new Error("must finalize in place"); },
    telegram: {
      send: async (text) => { updates.push({ text, at: Date.now() }); return 1; },
      edit: async (_id, text) => { updates.push({ text, at: Date.now() }); },
    },
  });
  await app.handle({ userId: 42, chatType: "private", text: "匀速", messageId: 1 });
  const first = updates[0]!;
  const last = updates.at(-1)!;
  const rate = (last.text.length - first.text.length) * 1000 / (last.at - first.at);
  assert.ok(rate >= 15 && rate <= 25, `unexpected typing rate: ${rate}`);
  assert.equal(last.text, complete);
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
