import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { Type } from "typebox";
import { cacheReport, conversationUsage } from "../src/assistant/cache-report.js";
import type { RequestMetric } from "../src/assistant/durable-models.js";
import type { StoredBatch } from "../src/assistant/queue.js";
import { assistantFixture } from "./fixtures/assistant.js";

function metric(batchId: string, input: number | null, cacheRead: number | null,
  extra: Partial<RequestMetric> = {}): RequestMetric {
  return { conversationId: "one", batchId, purpose: "execution", requestId: `${batchId}:request`,
    model: "local", provider: "local", api: "openai-completions", at: "2026-10-17T00:00:00Z",
    requestBytes: 100, durationMs: 10, input, output: 10, cacheRead, cacheWrite: null, status: "stop", ...extra };
}

async function reportFixture(records: RequestMetric[], batches: StoredBatch[] = [], suffix = "") {
  const directory = await mkdtemp(join(tmpdir(), "cache-report-"));
  const path = join(directory, "executions", createHash("sha256").update("one").digest("hex"));
  try {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "requests.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n" + suffix);
    return await cacheReport(directory, "one", batches);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("conversation summary deduplicates pending, excludes auxiliary and preserves unknown counters", async () => {
  const directory = await mkdtemp(join(tmpdir(),"conversation-usage-"));
  const path = join(directory,"executions",createHash("sha256").update("one").digest("hex"));
  try {
    await mkdir(path,{recursive:true});
    const records = [metric("turn",null,null,{status:"pending"}),metric("turn",100,900,{cacheWrite:100}),
      metric("other",999,999,{conversationId:"other"}),metric("aux",999,999,{purpose:"auxiliary"})];
    const save = () => writeFile(join(path,"requests.jsonl"),records.map(record => JSON.stringify(record)).join("\n"));
    await save();
    assert.deepEqual(await conversationUsage(directory,"one"),{input:100,output:10,cacheRead:900,cacheHit:900/1100*100});
    records.push(metric("missing",null,null,{output:3}));await save();
    assert.deepEqual(await conversationUsage(directory,"one"),{input:null,output:13,cacheRead:null,cacheHit:null});
    assert.deepEqual(await conversationUsage(directory,"empty"),{input:null,output:null,cacheRead:null,cacheHit:null});
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("cache report groups tool requests, replaces pending, weights tokens and includes cache writes", async () => {
  const report = await reportFixture([
    metric("turn", null, null, { status: "pending" }), metric("turn", 100, 900),
    metric("turn", 90, 10, { requestId: "tool-continuation", cacheWrite: 100 }),
  ]);
  assert.match(report, /命中率：75\.8%/);
  assert.match(report, /Hit：910\nMiss：290\n合计输入：1200/);
  assert.match(report, /完美反刍/);
  assert.doesNotMatch(report, /待结算|数据缺失|2\./);
});

test("cache report separates fields and rounds in plain text, with colors based on the unrounded rate", async () => {
  const cases: Array<[number, string]> = [
    [0, "🔴"], [4000, "🔴"], [4001, "🟠"], [7000, "🟠"], [7001, "🟡"],
    [8900, "🟡"], [9000, "🟡"], [9001, "🟢"], [10000, "🟢"],
  ];
  for (const [hit, icon] of cases) {
    const report = await reportFixture([metric("turn", 10000 - hit, hit)]);
    assert.equal(report.split("\n")[2], `1. ${icon} 命中率：${(hit / 100).toFixed(1)}%`);
  }
  const report = await reportFixture([metric("older", 1, 99), metric("newer", 11, 89)]);
  assert.equal(report, "🦖 【奶龙赛博反刍胃囊报表】\n\n" +
    "1. 🟡 命中率：89.0%\nHit：89\nMiss：11\n合计输入：100\n完美反刍，熟悉的味道又回来啦！\n\n" +
    "2. 🟢 命中率：99.0%\nHit：99\nMiss：1\n合计输入：100\n入口即化，嗷呜，一口就想起来啦！");
});

test("cache report shows newest five turns, excludes auxiliary and foreign metrics", async () => {
  const records = Array.from({ length: 6 }, (_, i) => metric(`turn-${i}`, i + 1, 0));
  records.push(metric("summary", 999, 999, { purpose: "auxiliary" }), metric("other", 888, 888, { conversationId: "other" }));
  const report = await reportFixture(records);
  assert.equal((report.match(/命中率：/g) ?? []).length, 5);
  assert.ok(report.indexOf("Miss：6") < report.indexOf("Miss：5"));
  assert.doesNotMatch(report, /Miss：1\b|999|888/);
});

test("cache report distinguishes pending, interrupted, missing and measured zero usage", async () => {
  const pending = metric("live", null, null, { status: "pending" });
  const batch: StoredBatch = { id: "live", requestKey: "live", conversationId: "one", events: [], resumed: false, reconcile: false, status: "running" };
  const live = await reportFixture([pending], [batch]);
  assert.match(live, /1\. ⚪ 命中率：不可用\n进行中 · 待结算\nHit：不可用/);
  assert.match(live, /进行中 · 待结算/); assert.match(live, /Hit：不可用/); assert.doesNotMatch(live, /数据缺失/);
  const stopped = await reportFixture([pending], [{ ...batch, status: "paused" }]);
  assert.match(stopped, /1\. ⚪ 命中率：不可用\n已暂停 · 数据缺失/);
  assert.match(stopped, /已暂停 · 数据缺失/); assert.doesNotMatch(stopped, /待结算/);
  const partial = await reportFixture([metric("partial", 1, 9), metric("partial", 100, null, { requestId: "missing" })]);
  assert.match(partial, /90\.0%（仅已知用量）/); assert.match(partial, /数据缺失/);
  assert.match(partial, /1\. ⚪ 命中率：90\.0%（仅已知用量）\n数据缺失/);
  assert.doesNotMatch(partial, /完美反刍/);
  const zero = await reportFixture([metric("zero", 0, 0)]);
  assert.match(zero, /⚪ 命中率：不可用/); assert.match(zero, /Hit：0\nMiss：0\n合计输入：0/);
  assert.doesNotMatch(zero, /数据缺失/);
});

test("old metrics are labeled per request and incomplete JSON is disclosed", async () => {
  const report = await reportFixture([metric("old", 5, 10, { requestId: undefined, batchId: undefined, purpose: undefined })], [], '{"requestId":');
  assert.match(report, /1\. 🟠 命中率：66\.7%\n历史请求（未记录轮次\/用途）\nHit：10\nMiss：5/);
  assert.match(report, /部分请求记录无法读取/);
});

function reply(response: ServerResponse, content: string, input: number, cached: number, tools?: unknown[], usage?: object) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content, ...(tools ? { tool_calls: tools } : {}) },
    finish_reason: tools ? "tool_calls" : "stop" }], usage: usage ?? { prompt_tokens: input, completion_tokens: 10, total_tokens: input + 10,
      prompt_tokens_details: { cached_tokens: cached } } })}\n\ndata: [DONE]\n\n`);
}

test("/kvcache queries live model/tool work immediately without generating, queuing or repeating a receipt", { timeout: 20000 }, async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let toolEntered!: () => void; const toolReady = new Promise<void>(resolve => { toolEntered = resolve; });
  let toolRelease!: () => void; const toolHeld = new Promise<void>(resolve => { toolRelease = resolve; });
  let calls = 0;
  const f = await assistantFixture(async (wire, response) => {
    assert.doesNotMatch(JSON.stringify(wire), /kvcache|胃囊报表/);
    calls++;
    if (calls === 1) {
      entered(); await held;
      reply(response, "", 1000, 900, [{ index: 0, id: "hold", type: "function", function: { name: "hold", arguments: "{}" } }]);
    } else reply(response, "finished", 100, 10);
  }, async () => ({ tools: [{ name: "hold", label: "hold", description: "Hold tool", parameters: Type.Object({}),
    async execute() { toolEntered(); await toolHeld; return { content: [{ type: "text", text: "done" }], details: {} }; } }] }));
  try {
    const input = { conversationId: "one", inputId: "query", text: "/kvcache", priority: 1000 };
    await f.app.receive({ conversationId: "one", inputId: "work", text: "do work" }); await ready;
    const receipt = await f.app.receive(input);
    const initial = f.outputs.at(-1)!;
    assert.equal(initial.type === "text" && initial.textFormat, "plain");
    assert.equal(receipt.accepted, true); assert.match(initial.type === "text" ? initial.text : "", /进行中 · 待结算/);
    assert.equal((await f.app.receive(input)).duplicate, true); assert.equal(f.outputs.length, 1); assert.equal(calls, 1);
    release(); await toolReady;
    await f.app.receive({ ...input, inputId: "query-tool" });
    const text = f.outputs.at(-1)!; assert.equal(text.type, "text");
    if (text.type === "text") { assert.match(text.text, /Hit：900\nMiss：100\n合计输入：1000/); assert.doesNotMatch(text.text, /待结算/); }
    assert.equal(f.app.routingStatus("one").works.length, 1, "queries do not create work");
    toolRelease(); await f.app.waitForIdle();
    await f.app.receive({ ...input, inputId: "query-done" });
    const done = f.outputs.at(-1)!; assert.equal(done.type, "text");
    if (done.type === "text") {
      assert.match(done.text, /命中率：82\.7%/); assert.match(done.text, /Hit：910\nMiss：190\n合计输入：1100/);
      assert.doesNotMatch(done.text, /进行中|待结算|数据缺失|\n2\./);
    }
    assert.equal(calls, 2);
  } finally { release(); toolRelease(); await f.close(); }
});

test("OpenAI compatible cache writes, top-level cache hits and absent input are measured from real SSE", { timeout: 20000 }, async () => {
  const usages = [
    { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 } },
    { prompt_tokens: 500, completion_tokens: 10, cached_tokens: 250 },
    { completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } },
    { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: null } },
  ];
  let calls = 0;
  const f = await assistantFixture((_wire, response) => { reply(response, "done", 0, 0, undefined, usages[calls++]); });
  try {
    for (let index = 0; index < usages.length; index++) {
      await f.app.receive({ conversationId: "one", inputId: `work-${index}`, text: "measure this turn" }); await f.app.waitForIdle();
      await f.app.receive({ conversationId: "one", inputId: `cache-${index}`, text: "/kvcache" });
      const output = f.outputs.at(-1)!; assert.equal(output.type, "text");
      if (output.type !== "text") continue;
      const row = output.text.split("\n\n")[1]!;
      if (index === 0) assert.match(row, /Hit：600\nMiss：400\n合计输入：1000/);
      else if (index === 1) assert.match(row, /Hit：250\nMiss：250\n合计输入：500/);
      else { assert.match(row, /数据缺失/); assert.match(row, /Hit：不可用/); }
    }
    assert.equal(calls, usages.length);
  } finally { await f.close(); }
});

test("Anthropic SSE counts cache creation as Miss and cache reads as Hit", { timeout: 20000 }, async () => {
  const f = await assistantFixture((_wire, response) => {
    const events = [
      { type: "message_start", message: { id: "anthropic-1", type: "message", role: "assistant", model: "local", content: [], stop_reason: null,
        usage: { input_tokens: 200, output_tokens: 0, cache_read_input_tokens: 700, cache_creation_input_tokens: 100 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  }, async () => ({ modelConfiguration: { defaultModel: "local", models: [
    { alias: "local", api: "anthropic-messages", model: "local", apiKey: "test", baseUrl: "" },
  ] } }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "work", text: "hello" }); await f.app.waitForIdle();
    await f.app.receive({ conversationId: "one", inputId: "cache", text: "/kvcache" });
    const output = f.outputs.at(-1)!; assert.equal(output.type, "text");
    if (output.type === "text") { assert.match(output.text, /命中率：70\.0%/); assert.match(output.text, /Hit：700\nMiss：300\n合计输入：1000/); }
  } finally { await f.close(); }
});

test("/kvcache survives reset/reopen, isolates conversations and handles empty/invalid queries without models", { timeout: 20000 }, async () => {
  let calls = 0;
  const f = await assistantFixture((wire, response) => {
    assert.doesNotMatch(JSON.stringify(wire.messages), /kvcache|胃囊报表/);
    calls++; reply(response, "answer", 200, 150);
  });
  const query = (conversationId: string, inputId: string, text = "/kvcache") => f.app.receive({ conversationId, inputId, text });
  const latest = () => { const output = f.outputs.at(-1)!; assert.equal(output.type, "text"); return output.type === "text" ? output.text : ""; };
  try {
    await query("one", "empty"); assert.match(latest(), /还没有模型请求/);
    await query("one", "bad", "/kvcache 10"); assert.match(latest(), /用法/); assert.equal(calls, 0);
    await f.app.receive({ conversationId: "one", inputId: "work", text: "hello" }); await f.app.waitForIdle();
    await query("one", "before"); const before = latest(); assert.match(before, /命中率：75\.0%/); assert.equal(calls, 1, "queries must not call model");
    await query("two", "isolated"); assert.match(latest(), /还没有模型请求/);
    await f.app.receive({ conversationId: "one", inputId: "reset", text: "/reset" }); await f.app.waitForIdle();
    await f.reopen();
    await query("one", "after"); assert.equal(latest(), before);
    assert.equal((await query("one", "before")).duplicate, true);
    await f.app.receive({ conversationId: "one", inputId: "help", text: "/help" }); await f.app.waitForIdle();
    assert.match(latest(), /\/kvcache/); assert.equal(calls, 1);
  } finally { await f.close(); }
});
