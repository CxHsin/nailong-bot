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
import { planProgressDetails, planStatusDetails } from "../src/channel/telegram/status-details.js";

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

test("one Run accumulates statuses, tools and multiple model findings in one progress message", async () => {
  const output = transport(); let sendsDuringRun = -1;
  const events = [
    event("progress", { type: "text", segmentId: "prep", kind: "status", text: "上下文准备完成", finalized: true }),
    text("first", "**第一项发现**", true),
    event("progress", { type: "tool", name: "read", callId: "r", state: "started" }),
    event("progress", { type: "tool", name: "read", callId: "r", state: "completed" }),
    text("second", "第二项发现：继续核对来源。", true),
    text("final", "最终答", false, "final"), text("final", "最终答案", true, "final"), event("run_succeeded"),
  ];
  const run = handle(events);
  const source = run.events;
  run.events = async function* () { for await (const value of source()) { if (value.type === "run_succeeded") sendsDuringRun = output.sent.length; yield value; } };
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5 }).consume(run);
  assert.equal(sendsDuringRun, 0);
  assert.equal(new Set(output.drafts.map((draft) => draft.id)).size, 1);
  assert.equal(output.sent.length, 2);
  assert.match(output.sent[0]!, /^<details><summary>运行进展<\/summary>/);
  assert.match(output.sent[0]!, /上下文准备完成/);
  assert.match(output.sent[0]!, /\*\*第一项发现\*\*/);
  assert.match(output.sent[0]!, /已完成：/);
  assert.match(output.sent[0]!, /第二项发现/);
  assert.doesNotMatch(output.sent[0]!, /最终答/);
  assert.equal(output.sent[1], "最终答案");
  assert.ok(output.drafts.some((draft) => draft.text.includes("第二项发现") && draft.text.includes("**第一项发现**")));
});

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
    assert.match(draft.text, /^<details open><summary>运行进展<\/summary>/);
    assert.match(draft.text, /<\/details>/);
  }
  assert.equal(output.sent[0], drafts.at(-1)!.text.split("\n\n最终答案")[0]!.replace("<details open>", "<details>"));
  assert.doesNotMatch(output.sent[0]!, /<details\s+open/);
  assert.match(output.sent[0]!, /\*\*模型发现\*\*/);
  assert.deepEqual(output.sent.slice(1), ["最终答案"]);
});

for (const open of [false, true]) test(`long runtime labels paginate into complete ${open ? "open" : "collapsed"} details without losing Unicode`, () => {
  const source = "<details open>**状态** & [链接](https://example.com) 👨‍👩‍👧‍👦\n".repeat(1000);
  const pages = planStatusDetails(source, open);
  assert.ok(pages.length > 1);
  for (const page of pages) {
    assert.ok(page.length <= 32768);
    assert.ok(page.startsWith(`<details${open ? " open" : ""}><summary>运行进展</summary>\n\n`));
    assert.match(page, /\n\n<\/details>$/);
    assert.equal(page.split(open ? "<details open>" : "<details>").length, 2);
    assert.doesNotMatch(page, /\*\*状态\*\*|\[链接\]/);
  }
  const restored = pages.map((page) => page.slice(page.indexOf("\n\n") + 2, -"\n\n</details>".length))
    .join("").replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
  // Markdown pagination can wrap lines and insert paragraph separators; every
  // visible character and encoded punctuation must survive, including graphemes.
  assert.equal(restored.replace(/\n/g, ""), source.replace(/\n/g, ""));
  assert.equal(restored.split("👨‍👩‍👧‍👦").length - 1, 1000);
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

test("finding Markdown streams inside progress while final Markdown remains outside", async () => {
  const output = transport();
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5 }).consume(handle([
    event("progress", { type: "text", segmentId: "prep", kind: "status", text: "上下文已准备好", finalized: true }),
    text("finding", "**已确认下载成功**，"),
    text("finding", "**已确认下载成功**，接下来核对解压权限。", true),
    event("progress", { type: "tool", name: "read", callId: "read", state: "started" }),
    event("progress", { type: "tool", name: "read", callId: "read", state: "completed" }),
    text("final", "最终答", false, "final"), text("final", "最终答案", true, "final"), event("run_succeeded"),
  ]));
  assert.ok(output.drafts.some((draft) => draft.text.includes("**已确认下载成功**，")));
  assert.ok(output.drafts.some((draft) => draft.text.endsWith("</details>\n\n最终答")));
  const finding = output.drafts.filter((draft) => draft.text.includes("**已确认"));
  assert.equal(new Set(finding.map((draft) => draft.id)).size, 1);
  assert.equal(new Set(output.drafts.map((draft) => draft.id)).size, 1);
  assert.match(output.sent[0]!, /\*\*已确认下载成功\*\*/);
  assert.equal(output.sent.at(-1), "最终答案");
  assert.match(output.sent[0]!, /已完成：/);
  assert.doesNotMatch(output.sent.join(""), /<blockquote|已完成\n/);
});

test("an unresolved Provider unit moves out of the journal when classified as final", async () => {
  const output = transport();
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5 }).consume(handle([
    event("progress", { type: "text", segmentId: "prep", kind: "status", text: "上下文已准备好", finalized: true }),
    text("pending", "待定正文"),
    text("pending", "最终答案", true, "final"), event("run_succeeded"),
  ]));
  assert.ok(output.drafts.some(({ text }) => /待定正文[\s\S]*<\/details>$/.test(text)));
  assert.ok(output.drafts.some(({ text }) => text.endsWith("</details>\n\n最终答案")));
  assert.equal(output.sent.length, 2);
  assert.doesNotMatch(output.sent[0]!, /待定正文|最终答案/);
  assert.equal(output.sent[1], "最终答案");
});

for (const terminal of ["run_failed", "run_cancelled"] as const) test(`${terminal} saves only settled progress and real states`, async () => {
  const output = transport();
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5 }).consume(handle([
    event("progress", { type: "text", segmentId: "prep", kind: "status", text: "上下文准备完成", finalized: true }),
    text("settled", "已确认公开结论", true), text("pending", "未完成说明"),
    text("discarded", "已撤回说明", true), event("progress", { type: "discard", segmentId: "discarded" }),
    text("final", "未完成答案", false, "final"), event(terminal),
  ]));
  assert.equal(output.sent.length, 2);
  assert.match(output.sent[0]!, /^<details>/);
  assert.match(output.sent[0]!, /上下文准备完成[\s\S]*已确认公开结论/);
  assert.doesNotMatch(output.sent[0]!, /未完成|已撤回/);
  assert.match(output.sent[1]!, terminal === "run_failed" ? /处理失败/ : /已取消/);
});

test("overflowing model findings stay in complete journal pages with fenced Markdown", async () => {
  const output = transport();
  const source = "**已确认分页资料**\n\n```ts\n" + "const 家庭 = '👨‍👩‍👧‍👦';\n".repeat(1800) + "```\n\n尾部结论";
  const pages = planProgressDetails(source);
  assert.ok(pages.length > 1);
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5 }).consume(handle([
    text("finding", source, true), text("final", "最终答案", true, "final"), event("run_succeeded"),
  ]));
  assert.deepEqual(output.sent.slice(0, -1), pages);
  for (const page of pages) {
    assert.ok(page.length <= 32768);
    assert.match(page, /^<details>/); assert.match(page, /<\/details>$/);
    assert.equal((page.match(/^```/gm) ?? []).length % 2, 0);
  }
  assert.equal(pages.join("").split("const 家庭").length - 1, 1800);
  assert.equal(pages.join("").split("👨‍👩‍👧‍👦").length - 1, 1800);
  assert.ok(output.drafts.every(({ text }) => text.length <= 32768));
  assert.ok(output.drafts.some(({ text }) => text.includes("尾部结论") && text.endsWith("</details>\n\n最终答案")));
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
  const output = transport(); const delivered: Array<{ text: string; source?: string }> = []; const receipts: Record<string, unknown>[] = [];
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5,
    recordProgress: async (_event, fact) => { receipts.push(fact); },
    deliver: async (_event, content) => { delivered.push(content); return { complete: true, messageId: 1 }; },
  }).consume(handle([
    event("progress", { type: "text", segmentId: "stale", kind: "progress", text: "旧结论", finalized: false, source: "progress-model" }),
    event("progress", { type: "discard", segmentId: "stale" }),
    event("progress", { type: "text", segmentId: "valid", kind: "progress", text: "已确认新来源", finalized: true, formal: true, source: "progress-model" }),
    event("run_succeeded"),
  ]));
  assert.deepEqual(delivered.map(({ text, source }) => ({ text, source })), [
    { text: "最终答案", source: "execution" },
  ]);
  assert.match(output.sent[0]!, /已确认新来源/); assert.doesNotMatch(output.sent[0]!, /旧结论/);
  assert.ok(receipts.some((fact) => fact.state === "sent" && Array.isArray(fact.segmentIds) && fact.segmentIds.includes("valid")));
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

test("a hanging journal send stops subsequent pages and cannot hold final delivery", async () => {
  const output = transport(); let attempts = 0; let aborted: AbortSignal | undefined;
  await createTelegramHostProjection({ ...output.rich, chatId: 42, progressTimeoutMs: 10,
    sendPage: async (_text, _chat, signal) => { attempts++; aborted = signal; await new Promise(() => {}); return 1; },
    deliver: async (_event, content) => { assert.equal(content.kind, "final"); output.sent.push(content.text); return { complete: true, messageId: 1 }; },
  }).consume(handle([text("first", "阶段结论一", true), text("second", "阶段结论二", true), event("run_succeeded")], 0));
  assert.equal(attempts, 1); assert.equal(aborted?.aborted, true); assert.equal(output.sent.at(-1), "最终答案");
});

test("a late journal page cannot dispatch remaining pages after the progress deadline", async () => {
  const output = transport(); let attempts = 0; let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const source = "公开结论".repeat(10000);
  assert.ok(planProgressDetails(source).length > 1);
  await createTelegramHostProjection({ ...output.rich, chatId: 42, progressTimeoutMs: 10,
    sendPage: async () => { attempts++; await wait; return 1; },
    deliver: async (_event, content) => { output.sent.push(content.text); return { complete: true, messageId: 2 }; },
  }).consume(handle([text("finding", source, true), event("run_succeeded")], 0));
  assert.deepEqual(output.sent, ["最终答案"]);
  release(); await delay(20);
  assert.equal(attempts, 1);
});

test("an unpageable journal cannot stop draft timers or final delivery", async () => {
  const output = transport(); const receipts: Record<string, unknown>[] = [];
  const source = "| h |\n| --- |\n| " + "x".repeat(40000) + " |";
  assert.throws(() => planProgressDetails(source), /表格行超过/);
  await createTelegramHostProjection({ ...output.rich, chatId: 42, draftIntervalMs: 5,
    recordProgress: async (_event, fact) => { receipts.push(fact); },
  }).consume(handle([text("finding", source, true), text("final", "最终答案", true, "final"), event("run_succeeded")], 30));
  assert.deepEqual(output.sent, ["最终答案"]);
  assert.ok(output.drafts.some(({ text }) => text === "最终答案"));
  assert.equal(receipts.filter((fact) => fact.source === "journal" && fact.reason === "planning").length, 1);
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
