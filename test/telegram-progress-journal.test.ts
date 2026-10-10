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
  const { draft: _draft, ...cardOnly } = rich;
  return { rich: cardOnly, visible, edits, finals };
}

test("retained journal uses one native draft for animated preparation text and persists only on finish", async () => {
  const output = transport(); const drafts: Array<{ id: number; text: string }> = [];
  const done = event("run_succeeded", { result: { text: "独立答案" } });
  const run: RunHandle = { runId: "native-preparation", conversationId: "telegram:42", done: Promise.resolve(done), cancel: async () => true,
    async *events() {
      yield progress({ type: "text", segmentId: "recall", kind: "status", text: "正在检索相关记忆……", finalized: true, actionState: "started" });
      await delay(40);
      assert.equal(output.visible.size, 0, "preparation should use the animated draft, not a persistent message");
      assert.ok(drafts.some((draft) => draft.text.includes("正在检索相关记忆")));
      yield progress({ type: "text", segmentId: "scan", kind: "status", text: "正在扫描记忆：32/80 条。", finalized: true, actionState: "started" });
      await delay(40);
      assert.ok(drafts.some((draft) => draft.text.includes("正在扫描记忆：32/80")));
      yield progress({ type: "text", segmentId: "history", kind: "status", text: "正在恢复历史记录：32/160 条已检查。", finalized: true, actionState: "started" });
      await delay(40);
      assert.ok(drafts.some((draft) => draft.text.includes("正在恢复历史记录：32/160")));
      yield done;
    } };
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5,
    draft: async (id, text) => { drafts.push({ id, text }); } }).consume(run);
  assert.ok(drafts.length >= 3);
  assert.equal(new Set(drafts.map((draft) => draft.id)).size, 1);
  assert.equal(output.visible.size, 1);
  assert.match(output.visible.get(1)!, /已完成/);
  assert.deepEqual(output.finals, ["独立答案"]);
  const count = drafts.length; await delay(30); assert.equal(drafts.length, count);
});

for (const failure of ["rejected", "timeout"] as const) test(`native draft ${failure} falls back to the editable journal and never holds final delivery`, async () => {
  const output = transport(); let attempts = 0; let signal: AbortSignal | undefined;
  const started = Date.now();
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 1, draftTimeoutMs: 15, progressIntervalMs: 0,
    draft: async (_id, _text, _chat, abort) => {
      attempts++; signal = abort;
      if (failure === "rejected") throw new Error("unavailable");
      await new Promise<void>(() => {});
    } }).consume(handle([
    progress({ type: "text", segmentId: "recall", kind: "status", text: "正在检索记忆", finalized: true, actionState: "started" }),
    progress({ type: "text", segmentId: "recall", kind: "status", text: "检索完成：72 条候选记忆。", finalized: true, actionState: "completed" }),
    event("run_succeeded", { result: { text: "最终答案" } }),
  ], 30));
  assert.ok(Date.now() - started < 1000);
  assert.equal(attempts, 1);
  if (failure === "timeout") assert.equal(signal?.aborted, true);
  assert.equal(output.visible.size, 1);
  assert.match(output.visible.get(1)!, /检索完成：72 条候选记忆/);
  assert.deepEqual(output.finals, ["最终答案"]);
});

test("discarded native preview disappears before cancellation and draft IDs change for the next Run", async () => {
  const output = transport(); const drafts: Array<{ id: number; text: string }> = [];
  const projection = createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 1,
    draft: async (id, text) => { drafts.push({ id, text }); } });
  await projection.consume(handle([
    progress({ type: "text", segmentId: "history", kind: "status", text: "正在恢复历史", finalized: false }),
    progress({ type: "text", segmentId: "discard", kind: "progress", text: "撤回预览", finalized: false }),
    progress({ type: "discard", segmentId: "discard" }),
    event("run_cancelled"),
  ], 20));
  assert.match(drafts.at(-1)!.text, /正在恢复历史/);
  assert.doesNotMatch(drafts.at(-1)!.text, /撤回预览/);
  const firstId = drafts.at(-1)!.id;
  await projection.consume(handle([
    progress({ type: "text", segmentId: "new", kind: "status", text: "新轮次", finalized: false }),
    event("run_failed"),
  ], 20));
  assert.notEqual(drafts.at(-1)!.id, firstId);
  assert.match(output.visible.get(2)!, /本轮处理失败/);
});

test("long native previews fit Telegram limits without splitting graphemes and retain the full terminal journal", async () => {
  const output = transport(); const drafts: string[] = [];
  const glyph = "👨‍👩‍👧‍👦"; const original = glyph.repeat(500);
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 1,
    draft: async (_id, text) => { drafts.push(text); } }).consume(handle([
    progress({ type: "text", segmentId: "long", kind: "progress", text: original, finalized: false }),
    progress({ type: "text", segmentId: "latest", kind: "status", text: "正在核对预算", finalized: true }),
    event("run_succeeded", { result: { text: "完成" } }),
  ], 20));
  assert.ok(drafts.length > 0);
  assert.ok(drafts.every((text) => text.length <= 4096), "native Rich draft must fit too, not just the HTML fallback");
  assert.ok(drafts.filter((text) => text.includes(glyph)).every((text) => text.replaceAll(glyph, "").replace("…", "") === ""));
  assert.ok(drafts.some((text) => text.includes("正在核对预算")), "an older long entry must not hide the current state");
  const content = [...output.visible.values()].join("");
  assert.ok(content.split(glyph).length - 1 >= 500);
});

test("folded journal updates states in order without a duplicated two-line preview", async () => {
  const t = transport(); const snapshots: string[] = [];
  await createTelegramHostProjection({ ...t.rich, chatId: 42, progressIntervalMs: 0,
    editPage: async (id, text, chat) => { snapshots.push(text); await t.rich.editPage!(id, text, chat); },
  }).consume(handle([
    progress({ type: "text", segmentId: "memory", kind: "status", text: "正在检索记忆", finalized: false }),
    progress({ type: "text", segmentId: "history", kind: "status", text: "历史上下文已恢复", finalized: true }),
    progress({ type: "text", segmentId: "memory", kind: "status", text: "检索完成：66 条候选记忆", finalized: true }),
    event("run_succeeded", { result: { text: "答案" } }),
  ], 10));
  assert.ok(snapshots.includes("<blockquote expandable>检索完成：66 条候选记忆\n\n历史上下文已恢复</blockquote>"));
  assert.equal(t.visible.get(1), "<blockquote expandable>检索完成：66 条候选记忆\n\n历史上下文已恢复\n\n已完成</blockquote>");
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
  assert.match(pages[0]!, /^<blockquote expandable>独特内容/);
  const combined = pages.join("");
  assert.equal(combined.split("独特内容。").length - 1, 1800);
  assert.doesNotMatch(combined, /未采用预览/);
  assert.deepEqual(t.finals, ["完成"]);
});

test("discarded states disappear from the live journal and the retained full journal", async () => {
  const t = transport(); const snapshots: string[] = [];
  await createTelegramHostProjection({ ...t.rich, chatId: 42, progressIntervalMs: 0,
    editPage: async (id, text, chat) => { snapshots.push(text); await t.rich.editPage!(id, text, chat); },
  }).consume(handle([
    progress({ type: "text", segmentId: "history", kind: "status", text: "历史已恢复", finalized: true }),
    progress({ type: "text", segmentId: "preview", kind: "progress", text: "撤回的摘要", finalized: false }),
    progress({ type: "discard", segmentId: "preview" }),
    event("run_cancelled"),
  ], 10));
  assert.ok(snapshots.includes("<blockquote expandable>历史已恢复</blockquote>"));
  assert.equal(t.visible.get(1), "<blockquote expandable>历史已恢复\n\n已取消</blockquote>");
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
