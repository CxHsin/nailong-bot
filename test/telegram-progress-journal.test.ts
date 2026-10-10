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
  const sent: string[] = []; const drafts: Array<{ id: number; text: string }> = [];
  const rich = createTelegramRichTransport({ sendRich: async (_chat, text) => { sent.push(text); return sent.length; },
    draftRich: async (id, _chat, text) => { drafts.push({ id, text }); } });
  return { rich, sent, drafts };
}

test("production projection streams final deltas before the Run finishes", async () => {
  const output = transport();
  const done = event("run_succeeded", { result: { text: "最终答案全文", finalText: "最终答案全文" } });
  const run: RunHandle = { runId: "stream-final", conversationId: "telegram:42", done: Promise.resolve(done), cancel: async () => true,
    async *events() {
      yield progress({ type: "text", segmentId: "answer", kind: "final", text: "最终答案", finalized: false });
      await delay(40);
      assert.ok(output.drafts.some(({ text }) => text === "最终答案"), "final deltas must be visible before run_succeeded");
      yield progress({ type: "text", segmentId: "answer", kind: "final", text: "最终答案全文", finalized: true }); yield done;
    } };
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5 }).consume(run);
  assert.deepEqual(output.sent, ["最终答案全文"]);
});

test("preparation changes animate one native draft and persist as Markdown at completion", async () => {
  const output = transport();
  const done = event("run_succeeded", { result: { text: "独立答案" } });
  const run: RunHandle = { runId: "preparation", conversationId: "telegram:42", done: Promise.resolve(done), cancel: async () => true,
    async *events() {
      yield progress({ type: "text", segmentId: "recall", kind: "status", text: "正在检索相关记忆……", finalized: true, actionState: "started" });
      await delay(40); assert.equal(output.sent.length, 0);
      assert.ok(output.drafts.some(({ text }) => text.includes("正在检索相关记忆")));
      yield progress({ type: "text", segmentId: "scan", kind: "status", text: "正在扫描记忆：32/80 条。", finalized: true, actionState: "started" });
      await delay(40); assert.ok(output.drafts.some(({ text }) => text.includes("正在扫描记忆：32/80")));
      yield done;
    } };
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5 }).consume(run);
  assert.equal(new Set(output.drafts.map(({ id }) => id)).size, 1);
  assert.equal(output.sent.at(-1), "独立答案");
  assert.ok(output.sent[0]!.includes("正在扫描记忆：32/80"));
  assert.doesNotMatch(output.sent.join(""), /<blockquote|<b>/);
});

test("discarded preview is not saved and later Runs use distinct draft IDs", async () => {
  const output = transport();
  const projection = createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5 });
  await projection.consume(handle([
    progress({ type: "text", segmentId: "preview", kind: "progress", text: "撤回预览", finalized: false }),
    progress({ type: "discard", segmentId: "preview" }), event("run_cancelled"),
  ], 20));
  const firstId = output.drafts[0]!.id;
  await projection.consume(handle([
    progress({ type: "text", segmentId: "history", kind: "status", text: "新轮次正在恢复历史", finalized: true }), event("run_failed"),
  ], 20));
  assert.notEqual(output.drafts.at(-1)!.id, firstId);
  assert.doesNotMatch(output.sent.join(""), /撤回预览/);
  assert.equal(output.sent.at(-1), "这条消息处理失败，请稍后重试。");
});

test("slash commands skip progress and deliver their sticker", async () => {
  const output = transport(); const stickers: string[] = [];
  await createTelegramHostProjection({ ...output.rich, chatId: 42,
    sendSticker: async (category) => { stickers.push(category); return 5; } }).consume(handle([
    event("run_submitted", { parts: [{ type: "text", text: "/dance" }] }),
    progress({ type: "text", segmentId: "s", kind: "status", text: "处理中", finalized: false }),
    event("run_succeeded", { result: { text: "跳舞", stickerCategory: "dance" } }),
  ]));
  assert.deepEqual(output.sent, []); assert.deepEqual(output.drafts, []); assert.deepEqual(stickers, ["dance"]);
});

test("hanging tools update elapsed draft time and stop publishing after completion", async () => {
  const output = transport();
  const done = event("run_succeeded", { result: { text: "完成" } });
  const run: RunHandle = { runId: "slow", conversationId: "telegram:42", done: Promise.resolve(done), cancel: async () => true,
    async *events() {
      yield progress({ type: "tool", name: "read", callId: "slow", state: "started" });
      await delay(5300); assert.match(output.drafts.at(-1)!.text, /已等待 5 秒/);
      yield progress({ type: "tool", name: "read", callId: "slow", state: "completed" }); yield done;
    } };
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 10 }).consume(run);
  assert.match(output.sent[0]!, /已完成/); assert.doesNotMatch(output.sent[0]!, /已等待|正在执行/);
  const count = output.drafts.length; await delay(30); assert.equal(output.drafts.length, count);
});

test("Host journals stage Markdown without changing raw facts and excludes progress receipts from replay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "native-journal-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "自然回答");
  const log = createRuntimeLog(dir); const output = transport();
  const host = createAgentHost({ log, dataDir: dir, promptFile, agent: { answer: async (_messages, request) => {
    await request.log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "stage", contentKind: "result", text: "**阶段成果**", protocolVersion: "plain-text-v3", source: "execution" });
    request.onProgress?.({ type: "text", segmentId: "stage", kind: "result", text: "**阶段成果**", finalized: true, formal: true });
    return "独立答案";
  } } });
  const run = host.submit({ actor: { id: "42" }, conversationId: "telegram:42", text: "开始" });
  await createTelegramHostProjection({ ...output.rich, chatId: 42,
    recordProgress: (event, fact) => host.recordProgress(event, fact),
    deliver: (event, content, signal) => host.deliverContent(event, content, output.rich, signal),
  }).consume(run);
  assert.deepEqual(output.sent, ["<details><summary>运行进展</summary>\n\n**阶段成果**\n\n</details>", "独立答案"]);
  const facts = await log.read();
  const receipts = facts.filter((fact) => fact.type === "telegram_progress_delivery");
  assert.ok(receipts.length > 0 && receipts.every((fact) => fact.contextPolicy === "exclude"));
  assert.ok(receipts.some((fact) => fact.source === "journal" && fact.state === "sent" && Array.isArray(fact.segmentIds) && fact.segmentIds.includes("stage")));
  assert.equal(facts.find((fact) => fact.type === "text_finalized" && fact.textSegmentId === "stage")?.text, "**阶段成果**");
  assert.doesNotMatch(JSON.stringify(projectDeliveredChat(facts)), /telegram_progress_delivery|messageId/);
});
