import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Bot } from "grammy";
import { Response as ApiResponse } from "node-fetch";
import { createTelegramService } from "../src/assistant/main.js";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { botInfo } from "./fixtures/telegram.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";
import { seedPendingAssistantWork } from "./fixtures/assistant.js";

const conversationId = "telegram:private:42";
const command = (id: number, text = "/start") => ({ update_id: id, message: {
  message_id: id, date: 0, chat: { id: 42, type: "private" as const, first_name: "owner" },
  from: { id: 42, is_bot: false, first_name: "owner" }, text,
} });
function telegramBoundary(failSend = false, onCall?: (method: string, body: Record<string, unknown>) => void) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const bot = new Bot("test", { client: { fetch: async (url, init) => {
    const method = String(url).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body)); calls.push({ method, body });
    onCall?.(method, body);
    if (failSend && method === "sendMessage") throw new Error("remote acceptance unknown");
    return new ApiResponse(JSON.stringify({ ok: true, result: method === "getMe" ? botInfo : method === "setMyCommands" ? true : {
      message_id: calls.length, date: 0, chat: { id: 42, type: "private" },
    } }), { headers: { "content-type": "application/json" } });
  } } });
  return { bot, calls };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function start(f: Awaited<ReturnType<typeof assistantFixture>>, boundary = telegramBoundary(), startupTimeoutMs?: number) {
  const service = await createTelegramService({ bot: boundary.bot,
    runtime: { app: f.app, dataDir: f.options.dataDir, close: () => f.app.close() }, ownerId: 42,
    download: async () => { throw new Error("unused"); }, reportFailure: () => {}, startupTimeoutMs });
  return { ...service, ...boundary };
}
test("production Telegram startup sends one independent main-model greeting and keeps controls usable", async () => {
  const wires: Wire[] = [];
  const metrics: Array<{ purpose?: string; input: number | null }> = [];
  const f = await assistantFixture((wire, response) => {
    wires.push(wire); sendChatCompletion(response, "嗷呜，奶龙上线啦！");
  }, async () => ({ prompt: "STARTUP_BASE_RULE", onRequestMetrics: metric => metrics.push(metric) }),
  { primaryConversationId: conversationId });
  const boundary = telegramBoundary();
  const service = await createTelegramService({ bot: boundary.bot, runtime: { app: f.app, dataDir: f.options.dataDir, close: () => f.app.close() },
    ownerId: 42, download: async () => { throw new Error("unused"); }, reportFailure: () => {} });
  try {
    assert.equal((await service.startup).status, "success");
    const greetings = boundary.calls.filter(call => call.method === "sendMessage");
    assert.equal(greetings.length, 1); assert.match(String(greetings[0]!.body.text), /奶龙上线/);
    await boundary.bot.handleUpdate(command(1)); await service.channel.finish();
    await boundary.bot.init();
    assert.equal(boundary.calls.filter(call => call.method === "getMe").length, 1);
    assert.equal(wires.length, 1);
    assert.equal(wires[0]!.tools?.length ?? 0, 0);
    assert.match(JSON.stringify(wires[0]!.messages), /STARTUP_BASE_RULE/);
    assert.match(JSON.stringify(wires[0]!.messages), /SELF/);
    assert.equal((await f.app.controlSnapshot(conversationId)).works.length, 0);
    assert.equal((await f.app.controlSnapshot(conversationId)).usage.input, null);
    assert.equal(metrics.length, 1); assert.equal(metrics[0]!.purpose, "auxiliary");
    assert.equal(metrics[0]!.input, null);
    const receipt = await readFile(join(f.options.dataDir, "telegram-sends.jsonl"), "utf8");
    assert.match(receipt, /startup/); assert.match(receipt, /sent/);
  } finally { await service.close(); await f.close(); }
});

test("startup without a selected main model offers controls without a model request", async () => {
  let requests = 0;
  const f = await assistantFixture((_wire, response) => { requests++; sendChatCompletion(response, "unexpected"); }, undefined,
    { primaryConversationId: conversationId, selectedModel: null });
  const service = await start(f);
  try {
    assert.equal((await service.startup).status, "unavailable");
    assert.equal(requests, 0);
    assert.match(String(service.calls.find(call => call.method === "sendMessage")?.body.text), /尚无可用主模型/);
    await service.bot.handleUpdate(command(1)); await service.channel.finish();
    assert.ok(service.calls.some(call => call.method === "sendMessage" && call.body.reply_markup));
  } finally { await service.close(); await f.close(); }
});

for (const failure of ["empty", "provider", "tool"] as const) {
  test(`startup ${failure} result reports failed model test once while the service stays available`, async () => {
    let requests = 0;
    const f = await assistantFixture((_wire, response) => {
      requests++;
      if (failure === "provider") { response.writeHead(503); response.end('{"error":{"message":"temporarily unavailable"}}'); }
      else if (failure === "tool") sendChatCompletion(response, "", [{ index: 0, id: "forbidden", type: "function",
        function: { name: "bash", arguments: '{"command":"echo not-authorized"}' } }]);
      else sendChatCompletion(response, "  ");
    }, undefined, { primaryConversationId: conversationId });
    const service = await start(f);
    try {
      const result = await service.startup;
      assert.equal(result.status, "failed"); assert.equal(result.model, "local");
      assert.equal(requests, 1);
      const message = service.calls.find(call => call.method === "sendMessage");
      assert.match(String(message?.body.text), /服务已启动.*模型测试未通过/);
      await service.bot.handleUpdate(command(1)); await service.channel.finish();
      assert.equal((await f.app.controlSnapshot(conversationId)).works.length, 0);
      assert.equal(requests, 1);
    } finally { await service.close(); await f.close(); }
  });
}

test("startup uses a finite total deadline and controls respond while generation is waiting", async () => {
  const entered = latch(), held = latch(); let requests = 0;
  const f = await assistantFixture(async (_wire, response) => {
    requests++; entered.release(); await held.promise; sendChatCompletion(response, "late success");
  }, undefined, { primaryConversationId: conversationId });
  const service = await start(f, undefined, 300);
  try {
    await entered.promise;
    await service.bot.handleUpdate(command(1)); await service.channel.finish();
    assert.ok(service.calls.some(call => call.method === "sendMessage" && call.body.reply_markup));
    const result = await service.startup;
    assert.equal(result.status, "failed"); assert.match(result.reason!, /超时/);
    held.release();
    assert.equal(requests, 1);
    assert.equal(service.calls.filter(call => call.method === "sendMessage" && /late success/.test(String(call.body.text))).length, 0);
  } finally { held.release(); await service.close(); await f.close(); }
});

test("startup freezes model and thinking, retains paused work, and records actual auxiliary usage", async () => {
  const entered = latch(), held = latch(); const wires: Array<Wire & { model: string; reasoning_effort: string }> = [];
  const metrics: Array<{ input: number | null; output: number | null; purpose?: string }> = [];
  const f = await assistantFixture(async (wire, response) => {
    wires.push(wire as typeof wires[number]); entered.release(); await held.promise;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "奶龙上线啦" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 31, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }, async directory => {
    await seedPendingAssistantWork(directory, conversationId);
    return { onRequestMetrics: metric => metrics.push(metric) };
  }, { primaryConversationId: conversationId, selectedModel: "old-model", catalog: [
    { id: "old-model", reasoning: true, supported_reasoning_levels: ["low", "high"] },
    { id: "new-model", reasoning: false },
  ] });
  await f.app.control(conversationId, { type: "thinking", level: "high" });
  const service = await start(f);
  try {
    await entered.promise;
    await f.app.control(conversationId, { type: "model", model: "new-model" });
    held.release();
    const result = await service.startup;
    assert.equal(result.status, "success"); assert.equal(result.model, "old-model"); assert.equal(result.thinking, "high");
    assert.equal(wires.length, 1); assert.equal(wires[0]!.model, "old-model"); assert.equal(wires[0]!.reasoning_effort, "high");
    assert.doesNotMatch(JSON.stringify(wires[0]!.messages), /unfinished background report/);
    const snapshot = await f.app.controlSnapshot(conversationId);
    assert.equal(snapshot.selectedModel, "new-model"); assert.equal(snapshot.status, "paused");
    assert.equal(snapshot.works.length, 1); assert.equal(snapshot.usage.input, null);
    assert.deepEqual(metrics.map(metric => ({ input: metric.input, output: metric.output, purpose: metric.purpose })),
      [{ input: 31, output: 7, purpose: "auxiliary" }]);
    assert.match(String(service.calls.find(call => call.method === "sendMessage")?.body.text), /old-model/);
  } finally { held.release(); await service.close(); await f.close(); }
});

test("closing production startup cancels generation and suppresses a late greeting", async () => {
  const entered = latch(), held = latch(); let requests = 0;
  const f = await assistantFixture(async (_wire, response) => {
    requests++; entered.release(); await held.promise; sendChatCompletion(response, "too late");
  }, undefined, { primaryConversationId: conversationId });
  const service = await start(f);
  try {
    await entered.promise;
    await service.close(); held.release();
    assert.equal((await service.startup).status, "cancelled");
    assert.equal(requests, 1); assert.equal(service.calls.filter(call => call.method === "sendMessage").length, 0);
  } finally { held.release(); await service.close(); await f.close(); }
});

test("unknown startup delivery retains successful model result and receipt without retry", async () => {
  let requests = 0;
  const f = await assistantFixture((_wire, response) => { requests++; sendChatCompletion(response, "奶龙上线"); }, undefined,
    { primaryConversationId: conversationId });
  const service = await start(f, telegramBoundary(true));
  try {
    assert.equal((await service.startup).status, "success");
    assert.equal(requests, 1); assert.equal(service.calls.filter(call => call.method === "sendMessage").length, 1);
    assert.match(await readFile(join(f.options.dataDir, "telegram-sends.jsonl"), "utf8"), /unknown/);
    assert.match(await readFile(join(f.options.dataDir, "startup-tests.jsonl"), "utf8"), /success/);
  } finally { await service.close(); await f.close(); }
});

test("a greeting finishing during ordinary work preserves that reply's streaming preview", { timeout: 6000 }, async () => {
  const startupEntered = latch(), releaseStartup = latch(), firstDraft = latch(), secondDraft = latch();
  let ordinary: ServerResponse | undefined; let requests = 0;
  const f = await assistantFixture(async (_wire, response) => {
    requests++;
    if (requests === 1) { startupEntered.release(); await releaseStartup.promise; sendChatCompletion(response, "奶龙上线啦"); return; }
    ordinary = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "FIRST_MAIN_DRAFT" }, finish_reason: null }] })}\n\n`);
  }, undefined, { primaryConversationId: conversationId });
  const service = await start(f, telegramBoundary(false, (method, body) => {
    if (method !== "sendRichMessageDraft") return;
    const text = JSON.stringify(body);
    if (text.includes("FIRST_MAIN_DRAFT")) firstDraft.release();
    if (text.includes("SECOND_MAIN_DRAFT")) secondDraft.release();
  }));
  try {
    await startupEntered.promise;
    await service.bot.handleUpdate(command(1, "Please work on a new request."));
    await service.channel.finish(); await firstDraft.promise;
    releaseStartup.release(); await service.startup;
    ordinary!.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " SECOND_MAIN_DRAFT" }, finish_reason: null }] })}\n\n`);
    await Promise.race([secondDraft.promise, delay(1800).then(() => { throw new Error("ordinary preview stopped after startup greeting"); })]);
    assert.equal(requests, 2);
  } finally {
    releaseStartup.release(); ordinary?.end("data: [DONE]\n\n");
    await service.close(); await f.close();
  }
});

test("Telegram initialization failure does not generate or send a ready announcement", async () => {
  let requests = 0; const methods: string[] = [];
  const f = await assistantFixture((_wire, response) => { requests++; sendChatCompletion(response, "unexpected"); }, undefined,
    { primaryConversationId: conversationId });
  const bot = new Bot("bad-token", { client: { fetch: async url => {
    methods.push(String(url).split("/").at(-1)!);
    return new ApiResponse(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }),
      { headers: { "content-type": "application/json" } });
  } } });
  try {
    await assert.rejects(createTelegramService({ bot, runtime: { app: f.app, dataDir: f.options.dataDir, close: () => f.app.close() },
      ownerId: 42, download: async () => { throw new Error("unused"); }, reportFailure: () => {} }), /Unauthorized/);
    assert.equal(requests, 0); assert.deepEqual(methods, ["getMe"]);
  } finally { await f.close(); }
});

test("each real Telegram service restart generates exactly one fresh greeting", async () => {
  let requests = 0;
  const f = await assistantFixture((_wire, response) => { requests++; sendChatCompletion(response, "又上线啦"); }, undefined,
    { primaryConversationId: conversationId });
  let service = await start(f);
  try {
    await service.startup; await service.close();
    await f.reopen(); service = await start(f); await service.startup;
    await service.bot.handleUpdate(command(1)); await service.channel.finish();
    assert.equal(requests, 2);
    const receipts = (await readFile(join(f.options.dataDir, "telegram-sends.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(receipts.filter(receipt => receipt.kind === "startup" && receipt.status === "sending").length, 2);
    const outcomes = (await readFile(join(f.options.dataDir, "startup-tests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(outcomes.length, 2); assert.notEqual(outcomes[0].id, outcomes[1].id);
  } finally { await service.close(); await f.close(); }
});
