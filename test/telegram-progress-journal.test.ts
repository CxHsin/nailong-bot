import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTelegramHostProjection } from "../src/channel/telegram/projection.js";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";
import type { HostEvent, RunHandle } from "../src/host/host.js";
import type { RunProgress } from "../src/runtime/progress.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { projectDeliveredChat } from "../src/application/runtime-projections.js";

function event(type: HostEvent["type"], extra: Partial<HostEvent> = {}): HostEvent {
  return { type, schemaVersion: 1, runId: "r", conversationId: "telegram:42", sequence: 1, at: new Date().toISOString(), ...extra };
}
const progress = (value: RunProgress) => event("progress", { progress: value });
function handle(events: HostEvent[], wait = 0): RunHandle {
  return { runId: "r", conversationId: "telegram:42", done: Promise.resolve(events.at(-1)!), cancel: async () => true,
    async *events() { for (const value of events) { yield value; if (wait) await delay(wait); } } };
}
function transport() {
  const visible = new Map<number, string>();
  const edits: number[] = []; const finals: string[] = [];
  const rich = createTelegramRichTransport({ sendRich: async (_chat, text) => { finals.push(text); return 99; },
    draftRich: async () => {}, draftHtml: async () => {},
    sendHtml: async (_chat, text) => { const id = visible.size + 1; visible.set(id, text); return id; },
    editHtml: async (id, _chat, text) => { edits.push(id); visible.set(id, text); } });
  return { rich, visible, edits, finals };
}

test("folded preview follows updates to existing states while the full journal keeps its order", async () => {
  const t = transport(); const snapshots: string[] = [];
  await createTelegramHostProjection({ ...t.rich, chatId: 42, progressIntervalMs: 0,
    editPage: async (id, text, chat) => { snapshots.push(text); await t.rich.editPage!(id, text, chat); },
  }).consume(handle([
    progress({ type: "text", segmentId: "memory", kind: "status", text: "正在检索记忆", finalized: false }),
    progress({ type: "text", segmentId: "history", kind: "status", text: "历史上下文已恢复", finalized: true }),
    progress({ type: "text", segmentId: "memory", kind: "status", text: "检索完成：66 条候选记忆", finalized: true }),
    event("run_succeeded", { result: { text: "答案" } }),
  ], 10));
  assert.ok(snapshots.some((html) => html.startsWith("<blockquote expandable>检索完成：66 条候选记忆\n历史上下文已恢复\n\n")));
  assert.match(t.visible.get(1)!, /^<blockquote expandable>已完成\n检索完成：66 条候选记忆\n\n检索完成：66 条候选记忆\n\n历史上下文已恢复\n\n已完成<\/blockquote>$/);
});

test("retained production journal edits one folded message, replaces tool states and separates final", async () => {
  const t = transport(); const receipts: Record<string, unknown>[] = [];
  await createTelegramHostProjection({ ...t.rich, chatId: 42, progressIntervalMs: 0,
    recordProgress: async (_event, fact) => { receipts.push(fact); } }).consume(handle([
    progress({ type: "text", segmentId: "s", kind: "progress", text: "我换条路径继续找。", finalized: false }),
    progress({ type: "tool", name: "read", callId: "a", state: "started" }),
    progress({ type: "tool", name: "read", callId: "a", state: "completed" }),
    progress({ type: "tool", name: "read", callId: "b", state: "failed" }),
    progress({ type: "text", segmentId: "final", kind: "final", text: "最终正文预览", finalized: false }),
    event("run_succeeded", { result: { text: "阶段结果\n\n答案", finalText: "答案" } }),
  ], 5));
  assert.equal(t.visible.size, 1);
  const text = t.visible.get(1)!;
  assert.match(text, /^<blockquote expandable>/);
  assert.match(text, /我换条路径继续找/);
  assert.match(text, /已完成：/); assert.match(text, /执行失败：/);
  assert.doesNotMatch(text, /正在执行|最终正文预览/);
  assert.ok(t.edits.length > 0 && t.edits.every((id) => id === 1));
  assert.deepEqual(t.finals, ["答案"]);
  assert.equal(receipts.filter((r) => r.state === "sent").length, 1);
});

test("long journal preserves all pages and withdraws discarded previews", async () => {
  const t = transport();
  await createTelegramHostProjection({ ...t.rich, chatId: 42, progressIntervalMs: 0 }).consume(handle([
    progress({ type: "text", segmentId: "preview", kind: "progress", text: "未采用预览", finalized: false }),
    progress({ type: "discard", segmentId: "preview" }),
    progress({ type: "text", segmentId: "long", kind: "result", text: "独特内容。".repeat(1800), finalized: true }),
    event("run_succeeded", { result: { text: "完成" } }),
  ], 5));
  assert.ok(t.visible.size > 1);
  const pages = [...t.visible.values()];
  assert.match(pages[0]!, /^<blockquote expandable>已完成\n独特内容/);
  const combined = [pages[0]!.slice(pages[0]!.indexOf("\n\n") + 2), ...pages.slice(1)].join("");
  assert.equal(combined.split("独特内容。").length - 1, 1800);
  assert.doesNotMatch(combined, /未采用预览/);
  assert.deepEqual(t.finals, ["完成"]);
});

test("discarded states disappear from the live preview as well as the full journal", async () => {
  const t = transport(); const snapshots: string[] = [];
  await createTelegramHostProjection({ ...t.rich, chatId: 42, progressIntervalMs: 0,
    editPage: async (id, text, chat) => { snapshots.push(text); await t.rich.editPage!(id, text, chat); },
  }).consume(handle([
    progress({ type: "text", segmentId: "history", kind: "status", text: "历史已恢复", finalized: true }),
    progress({ type: "text", segmentId: "preview", kind: "progress", text: "撤回的摘要", finalized: false }),
    progress({ type: "discard", segmentId: "preview" }),
    event("run_cancelled"),
  ], 10));
  assert.ok(snapshots.some((html) => html === "<blockquote expandable>历史已恢复\n\n历史已恢复</blockquote>"));
  assert.match(t.visible.get(1)!, /^<blockquote expandable>已取消\n历史已恢复\n\n/);
  assert.doesNotMatch(t.visible.get(1)!, /撤回的摘要/);
});

test("ambiguous timed-out send cannot trigger later page sends or block final", async () => {
  const t = transport(); let calls = 0; let release!: (id: number) => void;
  const pending = new Promise<number>((resolve) => { release = resolve; });
  const started = Date.now();
  await createTelegramHostProjection({ ...t.rich, chatId: 42, progressTimeoutMs: 20, progressIntervalMs: 0,
    sendPage: async () => { calls++; return pending; } }).consume(handle([
    progress({ type: "text", segmentId: "long", kind: "progress", text: "很多内容".repeat(2500), finalized: false }),
    event("run_succeeded", { result: { text: "及时答案" } }),
  ]));
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(t.finals, ["及时答案"]);
  release(1); await delay(25);
  assert.equal(calls, 1);
});

test("edit rejection freezes journal without duplicating it or blocking cancellation", async () => {
  const t = transport();
  await createTelegramHostProjection({ ...t.rich, chatId: 42, progressIntervalMs: 0,
    editPage: async () => { throw new Error("rate limit"); } }).consume(handle([
    progress({ type: "tool", name: "read", callId: "a", state: "started" }),
    progress({ type: "tool", name: "read", callId: "a", state: "failed" }),
    event("run_cancelled"),
  ], 5));
  assert.equal(t.visible.size, 1);
  assert.deepEqual(t.finals, ["这条消息已取消。"]);
});

test("slash command skips journal and sends its sticker", async () => {
  const t = transport(); const stickers: string[] = [];
  await createTelegramHostProjection({ ...t.rich, chatId: 42,
    sendSticker: async (category) => { stickers.push(category); return 5; } }).consume(handle([
    event("run_submitted", { parts: [{ type: "text", text: "/dance" }] }),
    progress({ type: "text", segmentId: "s", kind: "status", text: "处理中", finalized: false }),
    event("run_succeeded", { result: { text: "跳舞", stickerCategory: "dance" } }),
  ]));
  assert.equal(t.visible.size, 0); assert.deepEqual(stickers, ["dance"]);
});

test("hanging edit is bounded and failed runs retain accurate terminal status", async () => {
  const t = transport(); let calls = 0;
  await createTelegramHostProjection({ ...t.rich, chatId: 42, progressIntervalMs: 0, progressTimeoutMs: 20,
    editPage: async () => { calls++; await new Promise(() => {}); } }).consume(handle([
    progress({ type: "text", segmentId: "s", kind: "status", text: "正在查找", finalized: false, actionState: "started" }),
    progress({ type: "text", segmentId: "s", kind: "status", text: "未找到候选", finalized: false, actionState: "completed" }),
    event("run_failed"),
  ], 5));
  assert.equal(calls, 1); assert.deepEqual(t.finals, ["这条消息处理失败，请稍后重试。"]);

  const healthy = transport();
  await createTelegramHostProjection({ ...healthy.rich, chatId: 42 }).consume(handle([
    progress({ type: "tool", name: "read", callId: "a", state: "failed" }), event("run_failed"),
  ]));
  assert.match(healthy.visible.get(1)!, /执行失败/);
  assert.match(healthy.visible.get(1)!, /本轮处理失败/);
  assert.doesNotMatch(healthy.visible.get(1)!, /已完成/);
});

test("edit HTML gracefully handles unchanged text and unsupported expandable quotes", async () => {
  const calls: string[] = [];
  const t = createTelegramRichTransport({ sendRich: async () => 1, sendHtml: async () => 1, draftRich: async () => {}, draftHtml: async () => {},
    editHtml: async (_id, _chat, text) => {
      calls.push(text);
      if (text === "unchanged") throw new Error("message is not modified");
      if (text.includes("expandable")) throw Object.assign(new Error("unsupported blockquote entity"), { error_code: 400 });
    } });
  await t.editPage!(1, "unchanged", 42);
  await t.editPage!(1, "<blockquote expandable>正文</blockquote>", 42);
  assert.deepEqual(calls, ["unchanged", "<blockquote expandable>正文</blockquote>", "<blockquote>正文</blockquote>"]);
});

test("hanging tool refreshes elapsed time and stops editing after termination", async () => {
  const t = transport();
  const done = event("run_succeeded", { result: { text: "完成" } });
  const run: RunHandle = { runId: "r", conversationId: "telegram:42", done: Promise.resolve(done), cancel: async () => true,
    async *events() {
      yield progress({ type: "tool", name: "read", callId: "slow", state: "started" });
      await delay(5300);
      assert.match(t.visible.get(1)!, /已等待 5 秒/);
      yield progress({ type: "tool", name: "read", callId: "slow", state: "completed" });
      yield done;
    } };
  await createTelegramHostProjection({ ...t.rich, chatId: 42, progressIntervalMs: 0 }).consume(run);
  assert.doesNotMatch(t.visible.get(1)!, /已等待|正在执行/);
  const count = t.edits.length; await delay(300); assert.equal(t.edits.length, count);
});

test("Host delivers final independently of stages and excludes progress receipts from replay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "retained-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "自然回答");
  const log = createRuntimeLog(dir); const output = transport();
  const host = createAgentHost({ log, dataDir: dir, promptFile, agent: { answer: async (_messages, request) => {
    request.onProgress?.({ type: "text", segmentId: "stage", kind: "result", text: "阶段成果", finalized: true });
    return "独立答案";
  } } });
  const run = host.submit({ actor: { id: "42" }, conversationId: "telegram:42", text: "开始" });
  await createTelegramHostProjection({ ...output.rich, chatId: 42,
    recordProgress: (event, fact) => host.recordProgress(event, fact),
    deliver: (event, content) => host.deliverContent(event, content, output.rich),
  }).consume(run);
  const values = [...output.visible.values()];
  assert.ok(values.some((text) => text.includes("阶段成果") && text.includes("blockquote")));
  assert.ok(values.some((text) => text === "独立答案"));
  const facts = await log.read();
  const receipts = facts.filter((fact) => fact.type === "telegram_progress_delivery");
  assert.ok(receipts.length > 0 && receipts.every((fact) => fact.contextPolicy === "exclude"));
  assert.doesNotMatch(JSON.stringify(projectDeliveredChat(facts)), /telegram_progress_delivery|messageId/);
});
