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
      return Promise.race([report.done, new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("cache query waited for the running model")), 250);
        void report.done.finally(() => clearTimeout(timer));
      })]);
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
  assert.match(text, /四次|4 次/);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([cacheDelivered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Telegram cache query waited")), 500); })]); }
    finally { clearTimeout(timer); }
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
  const text = cacheReportText(report, new Date(at));
  assert.match(text, /2026\/10\/6 18:00:00/);
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
  try { await Promise.race([cacheDelivered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("CLI did not read the cache query during model work")), 250); })]); }
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
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test", memoryBootstrap: false,
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => agent.close());
  const host = createAgentHost({ dataDir: dir, promptFile: "system-prompt.md", log: createRuntimeLog(dir), agent });
  const run = host.submit({ actor: { id: "owner" }, conversationId: "c", text: "问题" });
  await streaming;
  const query = () => host.submit({ actor: { id: "owner" }, conversationId: "c", text: "/kvcache" }).done;
  let before;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { before = await Promise.race([query(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Provider blocked live query")), 500); })]); }
  finally { clearTimeout(timer); finish(); await run.done; }
  assert.match(String(before.result?.text), /待结算 1/);
  const after = await query();
  const report = after.result?.cache as ReturnType<typeof cacheStatistics>;
  assert.equal(report.current, undefined);
  assert.equal(report.recent[0]?.runId, run.runId);
  assert.deepEqual(report.execution, { hit: 80, miss: 20, input: 100, hitRate: 0.8, calls: 1, measured: 1, pending: 0 });
  assert.match(String(after.result?.text), /80\.00%/);
});
