import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { cacheStatistics, cacheReportText } from "../src/runtime/cache-statistics.js";
import { Bot } from "grammy";
import { Response as FetchResponse } from "node-fetch";
import { initializeTelegramHostChannel } from "../src/channel/telegram/host-channel.js";
import { createCliChannel } from "../src/cli/cli-channel.js";
import { createServer } from "node:http";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { marked } from "marked";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";

test("Telegram cache report preserves separate metric lines under standard Markdown rendering", async () => {
  const report = cacheStatistics([
    { type: "request_started", requestId: "report", conversationId: "c", at: "2026-10-10T00:00:00Z" },
    { type: "model_step_started", requestId: "report", modelStepId: "step", purpose: "execution", at: "2026-10-10T00:00:00Z" },
    { type: "model_usage", requestId: "report", callId: "step", purpose: "execution", usageAvailable: true,
      usage: { input: 10, cacheRead: 90, cacheWrite: 0 }, at: "2026-10-10T00:00:01Z" },
    { type: "run_succeeded", runId: "report", at: "2026-10-10T00:00:01Z" },
  ], "c");
  const sent: string[] = [];
  const transport = createTelegramRichTransport({ sendRich: async (_chat, markdown) => { sent.push(markdown); return 1; }, draftRich: async () => {} });
  await transport.send(cacheReportText(report), 42);
  const rendered = String(marked.parse(sent.join("\n\n"), { breaks: false }));
  assert.match(rendered, /<br>\s*♻️ 命中/);
  assert.match(rendered, /<br>\s*🆕 未命中/);
  assert.match(rendered, /<br>\s*合计输入/);
  assert.match(rendered, /<br>\s*首个执行调用/);
});

// This guards against a hung test; completion before releasing the model is the
// behavioral assertion, not a response-time SLA for filesystem work under load.
async function whileModelBlocked<T>(pending: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} did not complete while the model was held`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

test("cache query returns while model is running, refreshes settled usage and leaves reset queued", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cache-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let release!: () => void;
  let ready!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const log = createRuntimeLog(dir);
  let count = 0;
  const host = createAgentHost({ dataDir: dir, promptFile: "system-prompt.md", log, agent: { answer: async (_messages, request) => {
    count++;
    await request.log.append({ type: "model_step_started", requestId: request.id, modelStepId: "first", purpose: "execution" });
    ready(); await blocked;
    return "answer";
  } } });
  const run = host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "long work" });
  await started;
  let resetDone = false;
  const reset = host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "/reset" });
  void reset.done.then(() => { resetDone = true; });
  try {
    const query = async () => {
      const report = host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "/kvcache" });
      return whileModelBlocked(report.done, "Host cache query");
    };
    const before = await query();
    assert.equal(before.type, "run_succeeded");
    assert.match(String(before.result?.text), /待结算.*1/);
    assert.equal(resetDone, false);
    await log.append({ type: "model_usage", requestId: run.runId, callId: "first", purpose: "execution", conversationId: "c1",
      usageAvailable: true, usage: { cacheRead: 80, input: 20, cacheWrite: 0 } });
    const after = await query();
    assert.match(String(after.result?.text), /80\.00%/);
    assert.doesNotMatch(String(before.result?.text), /80\.00%/);
    assert.equal(count, 1);
    assert.equal(resetDone, false);
  } finally { release(); await run.done; await reset.done; }
});

test("cache report separates four ended runs, current run, pending and missing telemetry", () => {
  const events = [];
  for (let i = 0; i < 5; i++) events.push(
    { type: "request_started", requestId: `r${i}`, conversationId: "c", at: `2026-10-06T10:0${i}:00Z` },
    { type: "model_step_started", requestId: `r${i}`, conversationId: "c", modelStepId: "step", at: `2026-10-06T10:0${i}:00Z` },
    { type: "model_usage", requestId: `r${i}`, conversationId: "c", callId: "step", usageAvailable: true,
      usage: { cacheRead: 80, input: 10, cacheWrite: 10 }, at: `2026-10-06T10:0${i}:01Z` },
    { type: "run_succeeded", runId: `r${i}`, conversationId: "c", at: `2026-10-06T10:0${i}:02Z` },
  );
  events.push(
    { type: "request_started", requestId: "active", conversationId: "c", at: "2026-10-06T10:05:00Z" },
    { type: "model_step_started", requestId: "active", conversationId: "c", modelStepId: "missing", at: "2026-10-06T10:05:00Z" },
    { type: "model_usage", requestId: "active", conversationId: "c", callId: "missing", usageAvailable: false, at: "2026-10-06T10:05:01Z" },
    { type: "model_step_started", requestId: "active", conversationId: "c", modelStepId: "pending", at: "2026-10-06T10:05:02Z" },
  );
  const report = cacheStatistics(events, "c");
  assert.equal(report.execution.hitRate, 0.8, "cache writes are new input, not cache hits");
  const text = cacheReportText(report);
  assert.match(text, /奶龙赛博反刍胃囊报表/);
  assert.equal([...text.matchAll(/缓存命中率：/g)].length, 5);
  assert.doesNotMatch(text, /第[一二三四五]次/);
  assert.deepEqual([...text.matchAll(/^\*\*(\d)\./gm)].map((match) => match[1]), ["1", "2", "3", "4", "5"]);
  assert.equal(report.recent.length, 4);
  assert.doesNotMatch(text.split("**2.")[0]!, /入口即化|完美反刍|半生不熟|咯牙警告|🦖 “/);
  assert.equal(cacheReportText(report), text, "same run keeps the same quote");
  const idle = cacheStatistics([...events, { type: "run_succeeded", runId: "active", conversationId: "c", at: "2026-10-06T10:06:00Z" }], "c");
  assert.equal(idle.recent.length, 5);
  assert.equal([...cacheReportText(idle).matchAll(/缓存命中率：/g)].length, 5);
  assert.doesNotMatch(text, /查询快照|开始：|结束：|模型调用：|累计|辅助调用/);
  assert.match(text, /当前运行/);
  assert.match(text, /待结算.*1/);
  assert.match(text, /数据缺失.*1/);
  assert.doesNotMatch(text, /r0/);
});

test("Telegram accepts a live cache query during model work, authenticates and deduplicates it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-cache-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bot = new Bot("123:test", { client: { fetch: async (url) => new FetchResponse(JSON.stringify({ ok: true,
    result: String(url).endsWith("getMe") ? { id: 123, is_bot: true, first_name: "bot", username: "test_bot" } : true })) } });
  let release!: () => void;
  let ready!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const log = createRuntimeLog(dir);
  let modelCalls = 0;
  const host = createAgentHost({ dataDir: dir, promptFile: "system-prompt.md", log, agent: { answer: async (_messages, request) => {
    modelCalls++;
    await request.log.append({ type: "model_step_started", requestId: request.id, modelStepId: "call" });
    ready(); await blocked; return "answer";
  } } });
  const responses: string[] = [];
  let delivered!: () => void;
  const cacheDelivered = new Promise<void>((resolve) => { delivered = resolve; });
  const errors: unknown[] = [];
  const channel = await initializeTelegramHostChannel({ bot, ownerId: 42, host,
    transport: { send: async (text) => { responses.push(text); if (text.includes("胃囊报表")) delivered(); return responses.length; } },
    download: async () => { throw new Error("unexpected photo"); }, reportFailure: (error) => { errors.push(error); },
    onDelivered: (event, telegramMessageId) => host.recordDelivery(event, { channel: "telegram", telegramMessageId }) });
  let updateId = 0;
  const input = (id: number, text: string, actor = 42) => bot.handleUpdate({ update_id: ++updateId, message: { message_id: id, date: 0,
    from: { id: actor, is_bot: false, first_name: "owner" }, chat: { id: actor, type: "private", first_name: "owner" }, text } });
  await input(1, "long work");
  await started;
  try {
    await input(2, "/kvcache@test_bot");
    await whileModelBlocked(cacheDelivered, "Telegram cache query");
    assert.match(responses[0]!, /当前运行/);
    assert.match(responses[0]!, /待结算 1/);
    await input(2, "/kvcache@test_bot");
    await input(3, "/kvcache", 99);
    await input(4, "/kvcache@other_bot");
    assert.equal(modelCalls, 1);
  } finally { release(); await channel.finish(); }
  assert.deepEqual(errors, []);
  assert.equal(responses.filter((text) => text.includes("胃囊报表")).length, 1);
  assert.equal((await log.read()).filter((event) => event.type === "command_received" && event.command === "kvcache").length, 1);
});

test("unknown, zero and cancelled usage remain distinct and calls do not count twice", () => {
  const at = "2026-10-06T10:00:00Z";
  const events = [
    { type: "request_started", requestId: "r", conversationId: "c", at },
    { type: "model_step_started", requestId: "r", modelStepId: "zero", at },
    { type: "model_usage", requestId: "r", callId: "zero", usageAvailable: true, usage: { cacheRead: 0, input: 0 }, at },
    { type: "model_message", requestId: "r", modelStepId: "zero", message: { usage: { cacheRead: 999, input: 1 } }, at },
    { type: "model_step_started", requestId: "r", modelStepId: "unknown", at },
    { type: "model_message", requestId: "r", modelStepId: "unknown", message: { usage: { cacheRead: 0, input: 0 } }, at },
    { type: "model_step_started", requestId: "r", modelStepId: "abandoned", at },
    { type: "model_call_started", requestId: "r", callId: "summary", purpose: "summary", at },
    { type: "model_usage", requestId: "r", callId: "summary", purpose: "summary", usageAvailable: true, usage: { cacheRead: 50, input: 50 }, at },
    { type: "run_cancelled", runId: "r", conversationId: "c", at },
    { type: "model_usage", requestId: "foreign", conversationId: "other", callId: "foreign", usageAvailable: true, usage: { cacheRead: 1000, input: 0 }, at },
  ];
  const report = cacheStatistics(events, "c");
  assert.equal(report.current, undefined);
  assert.equal(report.recent[0]?.state, "cancelled");
  assert.deepEqual(report.execution, { hit: 0, miss: 0, input: 0, hitRate: null, calls: 3, measured: 1, pending: 0 });
  assert.equal(report.auxiliary.hitRate, 0.5);
  const text = cacheReportText(report);
  assert.match(text, /已取消/);
  assert.match(text, /数据缺失 2/);
  assert.match(text, /命中率：\*\*不可用\*\*/);
});

test("interactive CLI reads cache queries while its ordinary answer is still pending", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cli-cache-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let release!: () => void; let ready!: () => void; let delivered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const cacheDelivered = new Promise<void>((resolve) => { delivered = resolve; });
  const host = createAgentHost({ dataDir: dir, promptFile: "system-prompt.md", log: createRuntimeLog(dir), agent: { answer: async () => {
    ready(); await blocked; return "answer";
  } } });
  const cli = createCliChannel({ host, actor: { id: "owner" }, stdout: (line) => { if (line.includes("胃囊报表")) delivered(); }, stderr: () => {} });
  const chat = cli.chat((async function* () { yield "long work"; await started; yield "/kvcache"; })());
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Verify ordering while the model stays blocked, rather than timing Host startup/disk I/O under CI load.
  try { await started; await Promise.race([cacheDelivered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("CLI did not read the cache query during model work")), 5000); })]); }
  finally { clearTimeout(timer); release(); await chat; }
});

test("production Provider stream reports pending before usage and exact cache totals after settlement", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cache-stream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let ready!: () => void;
  let finish!: () => void;
  const streaming = new Promise<void>((resolve) => { ready = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "答" } }] })}\n\n`);
    finish = () => res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "案" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    ready();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test", memoryBootstrap: false,
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => agent.close());
  const host = createAgentHost({ dataDir: dir, promptFile: "system-prompt.md", log: createRuntimeLog(dir), agent });
  const run = host.submit({ actor: { id: "owner" }, conversationId: "c", text: "问题" });
  await streaming;
  const query = () => host.submit({ actor: { id: "owner" }, conversationId: "c", text: "/kvcache" }).done;
  let before;
  try { before = await whileModelBlocked(query(), "Provider cache query"); }
  finally { finish(); await run.done; }
  assert.match(String(before.result?.text), /待结算 1/);
  const after = await query();
  const report = after.result?.cache as ReturnType<typeof cacheStatistics>;
  assert.equal(report.current, undefined);
  assert.equal(report.recent[0]?.runId, run.runId);
  assert.deepEqual(report.execution, { hit: 80, miss: 20, input: 100, hitRate: 0.8, calls: 1, measured: 1, pending: 0 });
  assert.match(String(after.result?.text), /80\.00%/);
});

test("cache taste thresholds preserve exact boundaries and suppress incomplete judgments", () => {
  const report = cacheStatistics([], "c");
  for (const [rate, label] of [[0.91, "入口即化"], [0.9, "完美反刍"], [0.71, "完美反刍"], [0.7, "半生不熟"], [0.41, "半生不熟"], [0.4, "咯牙警告"]] as const) {
    report.recent = [{ runId: "stable", state: "succeeded", completedAt: "", auxiliary: report.auxiliary,
      execution: { hit: rate * 100, miss: (1 - rate) * 100, input: 100, hitRate: rate, calls: 1, measured: 1, pending: 0 } }];
    assert.ok(cacheReportText(report).includes(label));
    report.recent[0]!.execution.measured = 0;
    assert.doesNotMatch(cacheReportText(report), /🦖 “/);
  }
});

test("feed ratio increases by 0.1, caps at 0.9 and preserves higher configuration", async () => {
  const { fedContextRatio } = await import("../src/context/input-budget.js");
  assert.equal(fedContextRatio(0.5), 0.6);
  assert.equal(fedContextRatio(0.86), 0.9);
  assert.equal(fedContextRatio(0.95), 0.95);
});

test("cache report exposes each Run's first execution call even when later tool iterations hit cache", () => {
  const at = "2026-10-10T00:00:00Z";
  const events = [
    { type: "request_started", requestId: "first-run", conversationId: "c", at },
    { type: "model_step_started", requestId: "first-run", modelStepId: "cold", purpose: "execution", at },
    { type: "model_usage", requestId: "first-run", callId: "cold", usageAvailable: true, usage: { cacheRead: 0, input: 100 }, at },
    { type: "model_step_started", requestId: "first-run", modelStepId: "warm", purpose: "execution", at },
    { type: "model_usage", requestId: "first-run", callId: "warm", usageAvailable: true, usage: { cacheRead: 900, input: 0 }, at },
    { type: "model_call_started", requestId: "first-run", callId: "summary", purpose: "summary", at },
    { type: "model_usage", requestId: "first-run", callId: "summary", purpose: "summary", usageAvailable: true, usage: { cacheRead: 20, input: 80 }, at },
    { type: "run_succeeded", requestId: "first-run", conversationId: "c", at },
    { type: "request_started", requestId: "second-run", conversationId: "c", at },
    { type: "model_step_started", requestId: "second-run", modelStepId: "pending", purpose: "execution", at },
  ];
  const report = cacheStatistics(events, "c");
  assert.equal(report.recent[0]!.execution.hitRate, 0.9);
  assert.deepEqual(report.recent[0]!.firstExecution, { callId: "cold", usage: { hit: 0, miss: 100, input: 100, hitRate: 0, calls: 1, measured: 1, pending: 0 } });
  assert.equal(report.current!.firstExecution?.usage.pending, 1);
  const text = cacheReportText(report);
  assert.match(text, /首个执行调用：\*\*0\.00%\*\*/);
  assert.match(text, /首个执行调用：待结算/);
  assert.match(text, /摘要\/辅助调用.*20.*80/s);
});
