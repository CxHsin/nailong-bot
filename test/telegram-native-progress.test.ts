import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";
import { createTelegramHostProjection } from "../src/channel/telegram/projection.js";
import type { HostEvent, RunHandle } from "../src/host/host.js";
import type { RunProgress } from "../src/runtime/progress.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { deliverContent } from "../src/runtime/content-delivery.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planStatusDetails } from "../src/channel/telegram/status-details.js";

function event(type: HostEvent["type"], progress?: RunProgress): HostEvent {
  return { type, schemaVersion: 1, runId: "native", conversationId: "telegram:42", sequence: 1, at: new Date().toISOString(),
    ...(progress ? { progress } : {}), ...(type === "run_succeeded" ? { result: { text: "最终答案", finalText: "最终答案" } } : {}) };
}
function transport() {
  const sent: string[] = []; const drafts: Array<{ id: number; text: string }> = [];
  const rich = createTelegramRichTransport({ sendRich: async (_chat, text) => { sent.push(text); return sent.length; },
    draftRich: async (id, _chat, text) => { drafts.push({ id, text }); },
  });
  return { rich, sent, drafts };
}
function handle(events: HostEvent[], wait = 20): RunHandle {
  return { runId: "native", conversationId: "telegram:42", done: Promise.resolve(events.at(-1)!), cancel: async () => true,
    async *events() { for (const value of events) { yield value; await delay(wait); } } };
}
const text = (id: string, value: string, finalized = false, kind: "progress" | "final" = "progress") =>
  event("progress", { type: "text", segmentId: id, kind, text: value, finalized, formal: finalized && kind !== "final", source: "execution" });

test("runtime preparation stays open across draft updates and is collapsed only when saved", async () => {
  const output = transport();
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5 }).consume(handle([
    event("progress", { type: "text", segmentId: "memory", kind: "status", text: "正在检索记忆", finalized: true, actionState: "started" }),
    event("progress", { type: "text", segmentId: "memory", kind: "status", text: "检索完成：72 条候选记忆。", finalized: true, actionState: "completed" }),
    event("progress", { type: "text", segmentId: "context", kind: "status", text: "上下文已准备好，等待模型输出……", finalized: true, actionState: "completed" }),
    text("finding", "**模型发现**：资料已齐全。", true),
    text("final", "最终答案", true, "final"), event("run_succeeded"),
  ]));
  const drafts = output.drafts.filter((draft) => draft.text.includes("记忆"));
  assert.ok(drafts.length >= 2);
  assert.equal(new Set(drafts.map((draft) => draft.id)).size, 1);
  for (const draft of drafts) {
    assert.match(draft.text, /^<details open><summary>运行状态<\/summary>/);
    assert.match(draft.text, /<\/details>$/);
  }
  assert.equal(output.sent[0], drafts.at(-1)!.text.replace("<details open>", "<details>"));
  assert.doesNotMatch(output.sent[0]!, /<details\s+open/);
  assert.deepEqual(output.sent.slice(1), ["**模型发现**：资料已齐全。", "最终答案"]);
});

for (const open of [false, true]) test(`long runtime labels paginate into complete ${open ? "open" : "collapsed"} details without losing Unicode`, () => {
  const source = "<details open>**状态** & [链接](https://example.com) 👨‍👩‍👧‍👦\n".repeat(180);
  const pages = planStatusDetails(source, open);
  assert.ok(pages.length > 1);
  for (const page of pages) {
    assert.ok(page.length <= 3500);
    assert.ok(page.startsWith(`<details${open ? " open" : ""}><summary>运行状态</summary>\n\n`));
    assert.match(page, /\n\n<\/details>$/);
    assert.equal(page.split(open ? "<details open>" : "<details>").length, 2);
    assert.doesNotMatch(page, /\*\*状态\*\*|\[链接\]/);
  }
  const restored = pages.map((page) => page.slice(page.indexOf("\n\n") + 2, -"\n\n</details>".length))
    .join("").replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
  assert.equal(restored, source);
});

test("oversized status drafts stay within Rich limits and settlement preserves every collapsed page", async () => {
  const output = transport(); const source = "准备状态".repeat(10000) + "状态尾部标记";
  const pages = planStatusDetails(source);
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5 }).consume(handle([
    event("progress", { type: "text", segmentId: "prep", kind: "status", text: source, finalized: true }),
    text("final", "最终答案", true, "final"), event("run_succeeded"),
  ]));
  const draft = output.drafts.find((value) => value.text.includes("状态尾部标记"))!;
  assert.match(draft.text, /^<details open>/); assert.ok(draft.text.length <= 32768);
  assert.ok(draft.text.includes("状态尾部标记"));
  assert.deepEqual(output.sent.slice(0, -1), pages); assert.equal(output.sent.at(-1), "最终答案");
});

test("public findings and final answer stream and persist identical Markdown as separate units", async () => {
  const output = transport();
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5 }).consume(handle([
    event("progress", { type: "text", segmentId: "prep", kind: "status", text: "上下文已准备好", finalized: true }),
    text("finding", "**已确认下载成功**，"),
    text("finding", "**已确认下载成功**，接下来核对解压权限。", true),
    event("progress", { type: "tool", name: "read", callId: "read", state: "started" }),
    event("progress", { type: "tool", name: "read", callId: "read", state: "completed" }),
    text("final", "最终答", false, "final"), text("final", "最终答案", true, "final"), event("run_succeeded"),
  ]));
  assert.ok(output.drafts.some((draft) => draft.text === "**已确认下载成功**，"));
  assert.ok(output.drafts.some((draft) => draft.text === "最终答"));
  const finding = output.drafts.filter((draft) => draft.text.startsWith("**已确认"));
  assert.equal(new Set(finding.map((draft) => draft.id)).size, 1);
  assert.notEqual(finding[0]!.id, output.drafts.find((draft) => draft.text === "最终答")!.id);
  assert.ok(output.sent.includes(finding.at(-1)!.text));
  assert.equal(output.sent.at(-1), "最终答案");
  assert.ok(output.sent.indexOf(finding.at(-1)!.text) < output.sent.findIndex((value) => value.includes("已完成：")));
  assert.doesNotMatch(output.sent.join(""), /<blockquote|已完成\n/);
});

test("a rate-limited draft waits and resumes with the same ID without switching to a card", async () => {
  const output = transport(); const attempts: number[] = []; let firstFailureAt = 0;
  const projection = createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5,
    draft: async (id, value) => {
      attempts.push(id);
      if (attempts.length === 1) { firstFailureAt = Date.now(); throw { error_code: 429, parameters: { retry_after: 0.05 } }; }
      assert.ok(Date.now() - firstFailureAt >= 45);
      output.drafts.push({ id, text: value });
    } });
  await projection.consume(handle([text("final", "最终答", false, "final"), text("final", "最终答案", true, "final"), event("run_succeeded")], 100));
  assert.ok(attempts.length >= 2);
  assert.equal(new Set(attempts).size, 1);
  assert.equal(output.sent.at(-1), "最终答案");
});

test("draft and status sends that ignore cancellation cannot hold final delivery", async () => {
  const output = transport(); const receipts: Record<string, unknown>[] = [];
  const started = Date.now(); let aborted: AbortSignal | undefined;
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftTimeoutMs: 10, progressTimeoutMs: 10,
    draft: async (_id, _value, _chat, signal) => { aborted = signal; await new Promise(() => {}); },
    sendPage: async (value) => { if (value.includes("正在准备")) await new Promise(() => {}); output.sent.push(value); return 1; },
    recordProgress: async (_event, fact) => { receipts.push(fact); },
  }).consume(handle([event("progress", { type: "text", segmentId: "prep", kind: "status", text: "正在准备", finalized: true }), event("run_succeeded")], 0));
  assert.ok(Date.now() - started < 500);
  assert.equal(aborted?.aborted, true);
  assert.equal(output.sent.at(-1), "最终答案");
  assert.ok(receipts.some((receipt) => receipt.state === "draft_retry" && receipt.reason === "timeout"));
});

test("discarded auxiliary drafts never persist while settled auxiliary findings retain their source", async () => {
  const output = transport(); const delivered: Array<{ text: string; source?: string }> = [];
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5,
    deliver: async (_event, content) => { delivered.push(content); return { complete: true, messageId: 1 }; },
  }).consume(handle([
    event("progress", { type: "text", segmentId: "stale", kind: "progress", text: "旧结论", finalized: false, source: "progress-model" }),
    event("progress", { type: "discard", segmentId: "stale" }),
    event("progress", { type: "text", segmentId: "valid", kind: "progress", text: "已确认新来源", finalized: true, formal: true, source: "progress-model" }),
    event("run_succeeded"),
  ]));
  assert.deepEqual(delivered.map(({ text, source }) => ({ text, source })), [
    { text: "已确认新来源", source: "progress-model" }, { text: "最终答案", source: "execution" },
  ]);
  const count = output.drafts.length; await delay(20); assert.equal(output.drafts.length, count);
});

test("partial invalid Markdown keeps the last native preview and accepts a later complete snapshot", async () => {
  const calls: string[] = [];
  const rich = createTelegramRichTransport({ sendRich: async () => 1,
    draftRich: async (_id, _chat, value) => { calls.push(value); if (value === "**结论") throw { error_code: 400, description: "invalid markdown" }; } });
  await rich.draft(1, "前文", 42);
  await assert.rejects(rich.draft(1, "**结论", 42));
  await rich.draft(1, "**结论**", 42);
  assert.deepEqual(calls, ["前文", "**结论", "**结论**"]);
  assert.deepEqual(rich.plan({ id: "finding", text: "**结论**", kind: "progress" }), ["**结论**"]);
});

test("a hanging settled finding freezes later progress sends and cannot hold the final", async () => {
  const output = transport(); let attempts = 0; let aborted: AbortSignal | undefined;
  await createTelegramHostProjection({ ...output.rich, chatId: 42, progressTimeoutMs: 10,
    deliver: async (_event, content, signal) => {
      if (content.kind === "final") { output.sent.push(content.text); return { complete: true, messageId: 1 }; }
      attempts++; aborted = signal; await new Promise(() => {}); return { complete: false };
    },
  }).consume(handle([text("first", "阶段结论一", true), text("second", "阶段结论二", true), event("run_succeeded")], 0));
  assert.equal(attempts, 1); assert.equal(aborted?.aborted, true); assert.equal(output.sent.at(-1), "最终答案");
});

test("Rich delivery retries only the rejected Markdown page and preserves full fenced Unicode content", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "native-fallback-pages-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  const source = "```ts\n" + "const 家庭 = '👨‍👩‍👧‍👦';\n".repeat(500) + "```\n\n尾部结论";
  await log.append({ type: "text_finalized", requestId: "native", textSegmentId: "finding", contentKind: "progress", text: source, protocolVersion: "plain-text-v3" });
  const markdown: string[] = []; let rejected = false;
  const rich = createTelegramRichTransport({ draftRich: async () => {},
    sendRich: async (_chat, value) => { if (markdown.length === 1 && !rejected) { rejected = true; throw { error_code: 429 }; } markdown.push(value); return markdown.length; } });
  const planned = rich.plan({ id: "finding", text: source, kind: "progress" });
  assert.ok(planned.length > 1);
  const result = await deliverContent(log, "native", 42, { id: "finding", text: source, kind: "progress" }, rich);
  assert.equal(result.complete, true); assert.deepEqual(markdown, planned);
  assert.equal(markdown.join("").split("const 家庭").length - 1, 500);
  assert.equal(markdown.join("").split("👨‍👩‍👧‍👦").length - 1, 500);
  assert.match(markdown.at(-1)!, /尾部结论/);
  const facts = await log.read();
  assert.equal(facts.filter((fact) => fact.type === "telegram_delivery_succeeded").length, planned.length);
  assert.equal(facts.filter((fact) => fact.type === "telegram_delivery_attempt" && fact.partIndex === 0).length, 1);
});

test("a late progress page cannot dispatch later pages after its cancellation deadline", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "native-aborted-pages-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir); const source = "事实".repeat(5000);
  await log.append({ type: "text_finalized", requestId: "native", textSegmentId: "finding", contentKind: "progress", text: source, protocolVersion: "plain-text-v3" });
  let release!: () => void; let started!: () => void; let calls = 0;
  const ready = new Promise<void>((resolve) => { started = resolve; }); const wait = new Promise<void>((resolve) => { release = resolve; });
  const rich = createTelegramRichTransport({ sendRich: async () => { calls++; started(); await wait; return 1; }, draftRich: async () => {} });
  const controller = new AbortController();
  const delivery = deliverContent(log, "native", 42, { id: "finding", text: source, kind: "progress" }, rich, controller.signal);
  await ready; controller.abort(); release();
  assert.equal((await delivery).complete, false); assert.equal(calls, 1);
});
