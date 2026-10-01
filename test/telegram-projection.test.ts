import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";
import { createTelegramProjection } from "../src/telegram/telegram-projection.js";
import { formatMarkdownForTelegram } from "../src/telegram/telegram-format.js";

test("committed snapshots grow one Telegram message and finalize in place", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-projection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const visible = new Map<number, string>();
  let nextId = 100;
  const projection = createTelegramProjection({ log, chatId: 42,
    send: async (text) => { const id = ++nextId; visible.set(id, text); return id; },
    edit: async (id, text) => { visible.set(id, text); },
  });
  const first = await log.append({ type: "text_snapshot", requestId: "r1", modelStepId: "step-1",
    textSegmentId: "text-1", contentKind: "provisional", text: "我先检查" });
  await projection.reconcile("text-1");
  assert.deepEqual([...visible.values()], ["我先检查"]);
  const second = await log.append({ type: "text_snapshot", requestId: "r1", modelStepId: "step-1",
    textSegmentId: "text-1", contentKind: "provisional", text: "我先检查文件" });
  await projection.reconcile("text-1");
  assert.deepEqual([...visible.values()], ["我先检查文件"]);
  await log.append({ type: "text_finalized", requestId: "r1", modelStepId: "step-1",
    textSegmentId: "text-1", contentKind: "progress", text: "我先检查文件" });
  await projection.reconcile("text-1");
  assert.equal(nextId, 101);
  const events = await log.read();
  assert.equal(events.filter((event) => event.type === "telegram_delivery_attempt").length, 2);
  const success = events.filter((event) => event.type === "telegram_delivery_succeeded");
  assert.equal(success.length, 2);
  assert.equal(success[0]?.snapshotEventId, first.eventId);
  assert.equal(success[1]?.snapshotEventId, second.eventId);
  assert.ok(success.every((event) => event.telegramMessageId === 101));
});

test("unknown first send is not repeated after restart, while later text can send", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-unknown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  let sends = 0;
  const transport = { send: async (_text: string) => { sends++; throw new Error("timeout"); },
    edit: async (_id: number, _text: string) => {} };
  await log.append({ type: "text_snapshot", requestId: "r1", textSegmentId: "text-1",
    contentKind: "provisional", text: "可能已送达" });
  await createTelegramProjection({ log, chatId: 42, ...transport }).reconcile("text-1");
  await createTelegramProjection({ log, chatId: 42, ...transport }).reconcile("text-1");
  assert.equal(sends, 1);
  await log.append({ type: "text_snapshot", requestId: "r1", textSegmentId: "text-2",
    contentKind: "provisional", text: "下一段" });
  await createTelegramProjection({ log, chatId: 42, ...transport }).reconcile("text-2");
  assert.equal(sends, 2);
  assert.equal((await log.read()).filter((event) => event.type === "telegram_delivery_unknown").length, 2);
});

test("long final text is delivered in ordered parts before it is acknowledged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-long-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const text = "🐉".repeat(4100);
  await log.append({ type: "text_snapshot", requestId: "r1", textSegmentId: "text-1",
    contentKind: "provisional", text });
  await log.append({ type: "text_finalized", requestId: "r1", textSegmentId: "text-1",
    contentKind: "final", text });
  const received: string[] = [];
  let calls = 0;
  const projection = createTelegramProjection({ log, chatId: 42,
    send: async (part) => { received.push(part); return ++calls; },
    edit: async () => {},
  });
  await projection.reconcile("text-1");
  assert.equal(calls, 3);
  assert.equal(received.join(""), text);
  assert.ok(received.every((part) => part.length <= 4000));
  assert.equal(await projection.finalDelivered("text-1"), true);
});

test("a failed edit preserves durable text and later syncs a known message", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-edit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  let visible = "";
  let fail = true;
  const projection = createTelegramProjection({ log, chatId: 42,
    send: async (text) => { visible = text; return 50; },
    edit: async (_id, text) => { if (fail) throw new Error("rejected"); visible = text; },
    isRejected: () => true,
  });
  await log.append({ type: "text_snapshot", requestId: "r1", textSegmentId: "text-1",
    contentKind: "provisional", text: "开头" });
  await projection.reconcile("text-1");
  await log.append({ type: "text_snapshot", requestId: "r1", textSegmentId: "text-1",
    contentKind: "provisional", text: "开头和后续" });
  await projection.reconcile("text-1");
  assert.equal(visible, "开头");
  assert.ok((await log.read()).some((event) => event.type === "telegram_delivery_failed"));
  fail = false;
  await projection.reconcile("text-1");
  assert.equal(visible, "开头和后续");
  assert.equal((await log.read()).filter((event) => event.type === "telegram_delivery_succeeded").length, 2);
});

test("a delivery result commit failure remains a storage failure", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-commit-fault-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  await log.append({ type: "text_snapshot", requestId: "r1", textSegmentId: "text-1",
    contentKind: "provisional", text: "已写入快照" });
  let sent = 0;
  const faulty = { ...log, append: async (event: Parameters<typeof log.append>[0]) => {
    if (event.type === "telegram_delivery_succeeded") throw new Error("SQLite commit failed");
    return log.append(event);
  } };
  const projection = createTelegramProjection({ log: faulty, chatId: 42,
    send: async () => { sent++; return 7; }, edit: async () => {},
  });
  await assert.rejects(projection.reconcile("text-1"), /SQLite commit failed/);
  assert.equal(sent, 1);
  const events = await log.read();
  assert.equal(events.filter((event) => event.type === "telegram_delivery_attempt").length, 1);
  assert.equal(events.filter((event) => event.type === "telegram_delivery_unknown").length, 0);
  await createTelegramProjection({ log, chatId: 42,
    send: async () => { sent++; return 8; }, edit: async () => {},
  }).reconcile("text-1");
  assert.equal(sent, 1, "restart must not blindly repeat an unacknowledged first send");
});

test("Telegram projection renders Markdown without changing durable source text", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-markdown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const source = "**加粗** 和 [链接](https://example.com)";
  await log.append({ type: "text_snapshot", requestId: "r1", textSegmentId: "text-1",
    contentKind: "provisional", text: source });
  const calls: Array<{ text: string; mode?: string }> = [];
  const projection = createTelegramProjection({ log, chatId: 42,
    send: async (text, _chatId, mode) => { calls.push({ text, mode }); return 7; },
    edit: async () => {},
  });
  await projection.reconcile("text-1");
  assert.deepEqual(calls, [{ text: formatMarkdownForTelegram(source), mode: "HTML" }]);
  assert.match(calls[0]!.text, /<b>加粗<\/b>/);
  assert.equal((await log.read()).find((event) => event.type === "text_snapshot")?.text, source);
});
