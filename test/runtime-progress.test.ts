import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createTelegramHostProjection } from "../src/channel/telegram/index.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { memoryNodes } from "../src/runtime/memory-facts.js";
import { closeFixture } from "./fixtures/cleanup.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { DeliveryRejected } from "../src/application/app-types.js";
import { getModel } from "@mariozechner/pi-ai";
import { replayEvents } from "../src/context/projection.js";

test("ordinary assistant progress is delivered separately, replayed once and excluded from Akasha", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-progress-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "用中文回答。");
  const inputs: string[] = []; let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    inputs.push(body);
    const delta = calls++ === 0 ? { content: "先检查目录，以确认文件是否存在。", tool_calls: [{ index: 0, id: "list", type: "function", function: { name: "read", arguments: JSON.stringify({ path: promptFile }) } }] } : { content: "目录中有 prompt.md，检查完成。" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = createRuntimeLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const sent: string[] = []; const drafts: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42, draftIntervalMs: 5,
    draft: async (_id, text) => { drafts.push(text); }, send: async (text) => { sent.push(text); return sent.length; },
    onDelivered: (event, id) => host.recordDelivery(event, { channel: "telegram", telegramMessageId: id }) });
  await projection.consume(host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "检查目录" }));
  assert.equal(calls, 2);
  assert.deepEqual(sent, ["先检查目录，以确认文件是否存在。", "目录中有 prompt.md，检查完成。"]);
  assert.ok(drafts.some((text) => text.includes("先检查目录")));
  assert.equal(inputs[1]!.split("先检查目录，以确认文件是否存在。").length - 1, 1);
  const events = await log.read();
  assert.equal(events.some((event) => event.type === "protocol_feedback" || event.type === "protocol_validated"), false);
  assert.deepEqual(memoryNodes(events, 42)[0]?.messages.filter((message) => message.role === "assistant").map((message) => message.text), ["目录中有 prompt.md，检查完成。"]);
  await projection.consume(host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "接着回答" }));
  assert.equal(inputs[2]!.split("先检查目录，以确认文件是否存在。").length - 1, 1);
  assert.doesNotMatch(inputs[2]!, /正在调用|运行层协议反馈/);
});

test("production delivery retries known rejection, never repeats unknown progress and still delivers the final", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-delivery-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log, agent: {
    answer: async (_messages, request) => {
      await request.log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "p", contentKind: "progress", text: "正在核对来源。", protocolVersion: "plain-text-v3" });
      request.onProgress?.({ type: "text", segmentId: "p", kind: "progress", text: "正在核对来源。", finalized: true, formal: true });
      await request.log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "f", contentKind: "final", text: "确认结果。", protocolVersion: "plain-text-v3" });
      return "确认结果。";
    },
  } });
  let finals = 0; let progress = 0;
  const transport = { send: async (text: string) => {
    if (text.includes("来源")) { progress++; throw new Error("timeout, outcome unknown"); }
    if (++finals === 1) throw new DeliveryRejected("retry"); return 99;
  } };
  const projection = createTelegramHostProjection({ ...transport, chatId: 42,
    deliver: (event, content) => host.deliverContent(event, content, transport),
    onDelivered: (event, messageId) => host.recordDelivery(event, { channel: "telegram", telegramMessageId: messageId }) });
  const run = host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "核对" });
  await projection.consume(run);
  assert.equal(progress, 1); assert.equal(finals, 2);
  const facts = await log.read();
  assert.ok(facts.some((event) => event.type === "telegram_delivery_unknown" && event.textSegmentId === "p"));
  assert.ok(facts.some((event) => event.type === "delivery_succeeded"));
  assert.deepEqual(memoryNodes(facts, 42)[0]?.messages.filter((message) => message.role === "assistant").map((message) => message.text), ["确认结果。"]);
  await host.deliverContent(await run.done, { id: "p", text: "正在核对来源。", kind: "progress" }, transport);
  assert.equal(progress, 1);
});

test("startup records interrupted Runs once and never calls a model or redelivers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-interrupted-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  await log.append({ type: "run_started", runId: "active", conversationId: "c1" });
  await log.append({ type: "request_started", requestId: "active", conversationId: "c1" });
  await log.append({ type: "run_succeeded", runId: "done", conversationId: "c1", result: { text: "old" } });
  let calls = 0;
  const reopened = await createRuntimeEventLog(dir);
  const host = createAgentHost({ log: reopened, dataDir: dir, promptFile: join(dir, "prompt.md"), agent: { answer: async () => { calls++; return "unexpected"; } } });
  assert.equal(await host.recoverInterrupted(), 1);
  assert.equal(await host.recoverInterrupted(), 0);
  assert.equal(calls, 0);
  const facts = await reopened.read();
  assert.equal(facts.filter((event) => event.type === "request_interrupted").length, 1);
  assert.equal(facts.some((event) => event.type === "telegram_delivery_attempt"), false);
});

test("silence summaries use committed facts, do not block the task and are not repeated without new facts", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: new Date("2026-10-05T00:00:00Z") });
  const dir = await mkdtemp(join(tmpdir(), "runtime-summary-"));
  const log = createRuntimeLog(dir);
  let release!: () => void; let start!: () => void; let calls = 0;
  const ready = new Promise<void>((resolve) => { start = resolve; });
  const work = new Promise<void>((resolve) => { release = resolve; });
  const inputs: unknown[] = [];
  const host = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log, agent: {
    answer: async (_messages, request) => {
      await request.log.append({ type: "tool_dispatch", requestId: request.id, toolCallId: "slow", toolName: "web_fetch" });
      await request.log.append({ type: "tool_result", requestId: request.id, toolCallId: "slow", toolName: "web_fetch", modelVisible: "original",
        result: { content: [{ type: "text", text: "已取得网页标题：迁移指南" }], details: {}, isError: false } });
      start(); await work; return "最终结论。";
    },
    summarizeProgress: async (input: unknown) => { calls++; inputs.push(input); return "网页读取已开始，尚未取得结果。"; },
  } });
  const sent: string[] = []; let summaryDelivered!: () => void;
  const summarized = new Promise<void>((resolve) => { summaryDelivered = resolve; });
  const projection = createTelegramHostProjection({ chatId: 42, send: async (text) => { sent.push(text); summaryDelivered(); return sent.length; } });
  const consume = projection.consume(host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "查资料" }));
  t.after(async () => { release(); await consume; await rm(dir, { recursive: true, force: true }); });
  await ready; t.mock.timers.tick(15_000);
  const drain = async () => { for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  await summarized;
  assert.equal(calls, 1);
  assert.deepEqual(sent, ["网页读取已开始，尚未取得结果。"]);
  assert.match(JSON.stringify(inputs), /web_fetch/);
  assert.match(JSON.stringify(inputs), /已取得网页标题：迁移指南/);
  t.mock.timers.tick(120_000); await drain(); assert.equal(calls, 1);
  release(); await consume;
  assert.deepEqual(sent, ["网页读取已开始，尚未取得结果。", "最终结论。"]);
  assert.equal((await log.read()).filter((event) => event.type === "text_finalized" && event.source === "progress-model").length, 1);
});

test("discarded summaries never enter the actual next-turn model replay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-discard-replay-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  await log.append({ type: "message", role: "user", requestId: "old", text: "检索资料" });
  await log.append({ type: "text_finalized", requestId: "old", textSegmentId: "stale", text: "STALE_SUMMARY", source: "progress-model", contentKind: "progress", protocolVersion: "plain-text-v3" });
  await log.append({ type: "text_discarded", requestId: "old", textSegmentId: "stale", reason: "stale_summary" });
  await log.append({ type: "text_finalized", requestId: "old", textSegmentId: "valid", text: "已确认资料标题。", source: "progress-model", contentKind: "progress", protocolVersion: "plain-text-v3" });
  await log.append({ type: "message", role: "user", requestId: "current", text: "继续" });
  const replay = await replayEvents(log, "current", getModel("deepseek", "deepseek-v4-flash"), false);
  assert.doesNotMatch(JSON.stringify(replay.units), /STALE_SUMMARY/);
  assert.match(JSON.stringify(replay.units), /独立进展模型/);
  assert.equal(JSON.stringify(replay.units).split("已确认资料标题。").length - 1, 1);
});

test("a late silence summary is discarded after the main model changes direction", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: new Date("2026-10-05T00:00:00Z") });
  const dir = await mkdtemp(join(tmpdir(), "runtime-stale-")); const log = createRuntimeLog(dir);
  let continueWork!: () => void; let start!: () => void; let summaryStart!: () => void; let resolveSummary!: (text: string) => void;
  const ready = new Promise<void>((resolve) => { start = resolve; });
  const work = new Promise<void>((resolve) => { continueWork = resolve; });
  const summaryReady = new Promise<void>((resolve) => { summaryStart = resolve; });
  const pendingSummary = new Promise<string>((resolve) => { resolveSummary = resolve; });
  const host = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log, agent: {
    answer: async (_messages, request) => {
      await request.log.append({ type: "tool_dispatch", requestId: request.id, toolCallId: "slow", toolName: "web_fetch" });
      start(); await work;
      request.onProgress?.({ type: "text", segmentId: "new", kind: "progress", text: "已找到新来源。", finalized: true, formal: true });
      return "最终结果。";
    },
    summarizeProgress: async (_input, _request, _signal, onText) => { onText("旧来源仍在读取。"); summaryStart(); return pendingSummary; },
  } });
  const sent: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42, send: async (text) => { sent.push(text); return sent.length; } });
  const consume = projection.consume(host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "查资料" }));
  t.after(async () => { continueWork(); resolveSummary("旧来源仍在读取。"); await consume; await rm(dir, { recursive: true, force: true }); });
  await ready; t.mock.timers.tick(15_000); await summaryReady;
  continueWork(); await consume;
  resolveSummary("旧来源仍在读取。");
  for (let i = 0; i < 15; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ["已找到新来源。", "最终结果。"]);
  assert.equal((await host.readTimeline("telegram:private:42")).some((item) => item.source === "progress-model"), false);
});

test("silence summary scheduling enforces the 60 second interval and five attempt limit", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: new Date("2026-10-05T00:00:00Z") });
  const dir = await mkdtemp(join(tmpdir(), "summary-limit-")); const log = createRuntimeLog(dir);
  let release!: () => void; let start!: () => void; let requestId = ""; let calls = 0;
  const ready = new Promise<void>((resolve) => { start = resolve; }); const work = new Promise<void>((resolve) => { release = resolve; });
  const host = createAgentHost({ log, dataDir: dir, promptFile: join(dir, "prompt.md"), agent: {
    answer: async (_messages, request) => { requestId = request.id; start(); await work; return "完成"; },
    summarizeProgress: async () => { calls++; return "已提交新的读取事实。"; },
  } });
  const projection = createTelegramHostProjection({ chatId: 42, send: async () => 1 });
  const consume = projection.consume(host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "检查" }));
  t.after(async () => { release(); await consume; await rm(dir, { recursive: true, force: true }); });
  const drain = async () => { for (let i = 0; i < 30; i++) await log.read(); };
  const fact = (index: number) => log.append({ type: "tool_dispatch", requestId, conversationId: "telegram:private:42", toolName: "read", toolCallId: String(index) });
  await ready; await fact(0); t.mock.timers.tick(15_000); await drain(); assert.equal(calls, 1);
  await fact(1); t.mock.timers.tick(59_000); await drain(); assert.equal(calls, 1);
  t.mock.timers.tick(1000); await drain(); assert.equal(calls, 2);
  for (let index = 2; index < 6; index++) { await fact(index); t.mock.timers.tick(60_000); await drain(); }
  assert.equal(calls, 5);
});

for (const race of ["tool-result", "main-text"] as const) {
test(`${race} during summary settlement invalidates delivery and replay`, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: new Date("2026-10-05T00:00:00Z") });
  const dir = await mkdtemp(join(tmpdir(), "summary-commit-race-")); const raw = createRuntimeLog(dir);
  let release!: () => void; let start!: () => void;
  const ready = new Promise<void>((resolve) => { start = resolve; }); const work = new Promise<void>((resolve) => { release = resolve; });
  let summaryCommitted = false; let notify = () => {};
  const log = { ...raw, read: async () => {
    if (race === "main-text" && summaryCommitted) { summaryCommitted = false; notify(); }
    return raw.read();
  }, append: async (event: Parameters<typeof raw.append>[0]) => {
    if (race === "tool-result" && event.type === "text_finalized" && event.source === "progress-model") await raw.append({ type: "tool_result", requestId: event.requestId,
      conversationId: event.conversationId, toolName: "read", toolCallId: "slow", modelVisible: "original", result: { content: [{ type: "text", text: "新结果" }], details: {}, isError: false } });
    const result = await raw.append(event);
    if (event.type === "text_finalized" && event.source === "progress-model") summaryCommitted = true;
    return result;
  } };
  const host = createAgentHost({ log, dataDir: dir, promptFile: join(dir, "prompt.md"), agent: {
    answer: async (_messages, request) => { notify = () => request.onProgress?.({ type: "text", segmentId: "new", kind: "progress", text: "新方向", finalized: false });
      await request.log.append({ type: "tool_dispatch", requestId: request.id, toolName: "read", toolCallId: "slow" }); start(); await work; return "完成"; },
    summarizeProgress: async () => "STALE_COMMIT_SUMMARY",
  } });
  const sent: string[] = []; const projection = createTelegramHostProjection({ chatId: 42, send: async (text) => { sent.push(text); return 1; } });
  const run = host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "检查" }); const consume = projection.consume(run);
  t.after(async () => { release(); await consume; await rm(dir, { recursive: true, force: true }); });
  await ready; t.mock.timers.tick(15_000);
  const deadline = performance.now() + 5000;
  while (!(await raw.read()).some((event) => event.type === "text_discarded" && event.reason === "stale_summary") && performance.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const facts = await raw.read();
  assert.ok(facts.some((event) => event.type === "text_discarded" && event.reason === "stale_summary"));
  assert.deepEqual(sent, []);
  assert.doesNotMatch(JSON.stringify((await replayEvents(log, run.runId, getModel("deepseek", "deepseek-v4-flash"))).units), /STALE_COMMIT_SUMMARY/);
});
}

for (const mode of ["partial-pages", "commit-failure"] as const) {
  test(`formal delivery preserves unknown outcomes without learning or resending after ${mode}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "delivery-page-failure-")); t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = await createRuntimeEventLog(dir);
    const log = { ...raw, append: async (event: Parameters<typeof raw.append>[0]) => {
      if (mode === "commit-failure" && event.type === "telegram_delivery_succeeded") throw new Error("commit failed");
      return raw.append(event);
    } };
    const host = createAgentHost({ log, dataDir: dir, promptFile: join(dir, "prompt.md"), agent: {
      answer: async (_messages, request) => { await request.log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "final", contentKind: "final", protocolVersion: "plain-text-v3", text: "完整答案" }); return "完整答案"; },
    } });
    let calls = 0;
    const transport = { plan: () => ["第一页", "第二页"], send: async () => {
      calls++; if (mode === "partial-pages" && calls === 2) throw new Error("network outcome unknown"); return 77;
    } };
    const projection = createTelegramHostProjection({ ...transport, chatId: 42,
      deliver: (event, content) => host.deliverContent(event, content, transport), onDelivered: (event, id) => host.recordDelivery(event, { channel: "telegram", telegramMessageId: id }) });
    const run = host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "给我答案" });
    if (mode === "commit-failure") await assert.rejects(projection.consume(run), /commit failed/);
    else await projection.consume(run);
    const facts = await log.read();
    assert.equal(facts.some((event) => event.type === "delivery_succeeded"), false);
    assert.equal(memoryNodes(facts, 42)[0]?.messages.some((message) => message.role === "assistant"), false);
    const attemptsBefore = calls;
    const result = await host.deliverContent(await run.done, { id: "final", text: "完整答案", kind: "final" }, transport);
    assert.equal(result.outcome, "unknown"); assert.equal(calls, attemptsBefore);
    assert.equal(facts.filter((event) => event.type === "telegram_delivery_succeeded").length, mode === "partial-pages" ? 1 : 0);
  });
}
