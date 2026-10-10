import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createPiAgent } from "../src/agent/pi-agent.js";
import type { ToolResult, RuntimeLog } from "../src/runtime/runtime-types.js";
import { EVALUATION_START, EVALUATION_NOW, evaluationCases, evaluationCorpus, evaluationVector } from "./fixtures/memory-evaluation.js";
import { DEFAULT_DYNAMICS } from "../src/memory/dynamics.js";
import { closeFixture } from "./fixtures/cleanup.js";
import { discoveredToolPlan } from "./fixtures/discovered-tools.js";
import { createTelegramHostFixture, type TelegramHostFixtureOptions } from "./fixtures/telegram-host.js";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";
import { createEmbeddingClient } from "../src/memory/embedding.js";
import { createTestServer } from "./fixtures/http-server.js";
import { getModel } from "@mariozechner/pi-ai";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";
import { replayEvents } from "../src/context/projection.js";
const plans = new WeakMap<ServerResponse, ReturnType<typeof discoveredToolPlan>>();

type Payload = { messages: Array<{ role: string; content?: unknown }>; tools?: unknown[] };
let toolSequence = 0;
function answer(res: ServerResponse, text: string, tool?: { name: string; args: unknown }) {
  if (tool) tool = plans.get(res)?.select(tool.name, tool.args) ?? tool;
  const delta = tool ? { tool_calls: [{ index: 0, id: `memory-call-${++toolSequence}`, type: "function",
    function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } :
    { content: text };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}
export async function memoryFixture(t: TestContext, respond: (data: Payload, res: ServerResponse) => void,
  extra: Partial<TelegramHostFixtureOptions["agentOptions"]> = {},
  channelOptions: Omit<TelegramHostFixtureOptions, "agentOptions"> = {},
  legacySource?: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "nailong-memory-"));
  const seen: Payload[] = [];
  const plan = discoveredToolPlan();
  const server = createTestServer(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data: Payload = JSON.parse(body); seen.push(data); plans.set(res, plan);
    if (!plan.continue(data, res)) respond(data, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let shutdown = async () => {};
  t.after(() => closeFixture({ server, dir, shutdown: () => shutdown() }));
  const options = { dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false, ...extra };
  await legacySource?.(dir);
  const channel = await createTelegramHostFixture(t, { agentOptions: options, ...channelOptions });
  shutdown = () => channel.close();
  return { dir, seen, sent: channel.sent, failures: channel.failures, deliveries: channel.deliveries,
    get rootLog() { return channel.rootLog; }, get scopedLog() { return channel.scopedLog; },
    memoryVector: (text: string) => channel.agent.memoryVector(text),
    send: channel.send, sendUpdate: channel.sendUpdate,
    async restart(clearCaches: string[] = [], beforeOpen?: () => Promise<void>) { await channel.restart(async () => { for (const name of clearCaches) await rm(join(dir, name), { force: true }); await beforeOpen?.(); }); },
  };
}

test("Agent searches original Chinese memories across reset and restart", async (t) => {
  const f = await memoryFixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "tool") answer(res, String(last.content));
    else if (last.content === "查找 limboo") answer(res, "", { name: "memory_search", args: { query: "limboo" } });
    else answer(res, "我是助手说的：联机很开心");
  });
  await f.send("limboo 是我的舍友，我们玩杀戮尖塔");
  await f.send("/reset"); await f.restart(); await f.send("查找 limboo");
  assert.match(f.sent.at(-1)!, /limboo 是我的舍友/);
  assert.match(f.sent.at(-1)!, /联机很开心/);
  assert.match(f.sent.at(-1)!, /assistant/);
  assert.match(f.sent.at(-1)!, /user/);
  assert.ok((await f.rootLog.read()).some((e) => e.type === "capability_dispatched" && e.toolName === "memory_search"));
});

test("memory tools omit unseen assistant text and excluded turns, preserve failed user input", async (t) => {
  const f = await memoryFixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "tool") answer(res, String(last.content));
    else answer(res, "", { name: "memory_search", args: { query: "引流条" } });
  });
  await f.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "failed", text: "引流条流血", originalText: "引流条流血" });
  await f.rootLog.append({ type: "answer_generated", requestId: "failed", text: "引流条没事（未送达）" });
  await f.rootLog.append({ type: "request_failed", requestId: "failed" });
  await f.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "excluded", text: "引流条秘密" });
  await f.rootLog.append({ type: "memory_excluded", nodeId: "excluded" });
  await f.send("查询");
  assert.match(f.sent.at(-1)!, /引流条流血/);
  assert.doesNotMatch(f.sent.at(-1)!, /未送达|秘密/);
});

test("Agent follows a stable source to read contiguous Unicode memory after index removal", async (t) => {
  let source: { nodeId: string; messages: Array<{ id: string }> } | undefined;
  const f = await memoryFixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role !== "tool") answer(res, "", { name: "memory_search", args: { query: "杀戮尖塔" } });
    else if (!source) {
      source = JSON.parse(String(last.content))[0];
      answer(res, "", { name: "memory_read", args: { nodeId: source!.nodeId, messageId: source!.messages[0]!.id, offset: 5, limit: 4 } });
    } else answer(res, String(last.content));
  });
  await f.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "old", text: "杀戮尖塔：🎮一起玩" });
  await f.send("查旧事");
  assert.equal(JSON.parse(f.sent.at(-1)!).text, "🎮一起玩");
  await rm(join(f.dir, "memory.sqlite")); source = undefined;
  await f.restart(); await f.send("再查旧事");
  assert.equal(JSON.parse(f.sent.at(-1)!).text, "🎮一起玩");
});

test("legacy delivered assistant replies and original image references stay queryable", async (t) => {
  const f = await memoryFixture(t, (data, res) => {
    if (data.messages.at(-1)!.role === "tool") answer(res, String(data.messages.at(-1)!.content));
    else answer(res, "", { name: "memory_search", args: { query: "旧图片" } });
  }, {}, {}, async (dir) => {
    const old = [
    { type: "message", role: "user", chatId: 42, requestId: "old-image", text: "旧图片配文", images: [{ mimeType: "image/png", data: "original" }] },
    { type: "text_finalized", requestId: "old-image", textSegmentId: "old-final", contentKind: "final", protocolVersion: "json-text-v1", text: "旧版已送达正文" },
    { type: "telegram_delivery_succeeded", requestId: "old-image", textSegmentId: "old-final", partIndex: 0 },
    { type: "delivery_succeeded", requestId: "old-image" },
    ].map((event, index) => ({ ...event, at: new Date(1760000000000 + index).toISOString() }));
    await writeFile(join(dir, "events.jsonl"), old.map((event) => JSON.stringify(event)).join("\n") + "\n");
  });
  await f.send("查询");
  assert.match(f.sent.at(-1)!, /旧版已送达正文/);
  assert.match(f.sent.at(-1)!, /imageIndex/);
  assert.doesNotMatch(f.sent.at(-1)!, /original/);
});

test("each request automatically recalls old original text across reset within one snapshot", async (t) => {
  const f = await memoryFixture(t, (data, res) => answer(res, "已处理"));
  await f.send("limboo 是战士，我们玩杀戮尖塔");
  await f.send("/reset"); await f.send("limboo 最近玩啥");
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /limboo 是战士/);
  const events = await f.rootLog.read();
  const current = events.findLast((e) => e.type === "request_started")!.requestId;
  assert.equal(events.filter((e) => e.type === "memory_recalled" && e.requestId === current).length, 1);
  assert.ok(events.some((e) => e.type === "memory_presented" && e.requestId === current));
});

test("automatic memory quotes obey budgets, exceed eight short nodes and preserve the current question", async (t) => {
  const f = await memoryFixture(t, (_data, res) => answer(res, "答复"), { memoryBudget: { maxTokens: 1000 } });
  for (let index = 0; index < 12; index++) await f.rootLog.append({ type: "message", role: "user", chatId: 42,
    requestId: `old-${index}`, text: `limboo ${index}` });
  await f.send("/reset");
  await f.send("limboo 当前问题");
  const presented = (await f.rootLog.read()).findLast((e) => e.type === "memory_presented")!;
  assert.ok(Number(presented.tokens) <= 1000);
  assert.ok((presented.shown as unknown[]).length > 8);
  assert.equal(f.seen.at(-1)!.messages.at(-1)!.content, "limboo 当前问题");
  await f.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "huge", text: "limboo " + "🎮".repeat(20_000) });
  await f.send("/reset"); await f.send("limboo 当前问题");
  const bounded = (await f.rootLog.read()).findLast((e) => e.type === "memory_presented")!;
  assert.ok(Number(bounded.tokens) <= 1000);
  assert.ok(JSON.stringify(f.seen.at(-1)!.messages).length < 30_000);
});

test("automatic Chinese excerpts include a match at the end of a long original", async (t) => {
  const f = await memoryFixture(t, (_data, res) => answer(res, "答复"), { memoryBudget: { maxTokens: 350 } });
  await f.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "long", text: "我和舍友聊了很久" + "无关前言".repeat(3000) + "杀戮尖塔是我们玩的游戏" });
  await f.send("/reset"); await f.send("我和舍友最近还玩杀戮尖塔吗");
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /杀戮尖塔是我们玩的游戏/);
});

test("a rejected provider call never commits a memory presentation", async (t) => {
  const f = await memoryFixture(t, (_data, res) => { res.writeHead(401); res.end(JSON.stringify({ error: { message: "unauthorized" } })); });
  await f.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "old", text: "limboo 是战士" });
  await f.send("/reset"); await f.send("limboo");
  assert.equal((await f.rootLog.read()).some((e) => e.type === "memory_presented"), false);
});

test("remote embeddings recall a paraphrase after background indexing and reuse cached vectors", async (t) => {
  let requests = 0; const indexed = new Set<string>();
  const embeddingServer = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const input: string[] = JSON.parse(body).input; requests++;
    input.forEach((text) => indexed.add(text));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: /睡眠|作息/.test(text) ? [1, 0, 0] : [0, 1, 0] })) }));
  });
  await new Promise<void>((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { embeddingServer.closeAllConnections(); embeddingServer.close(() => resolve()); }));
  const address = embeddingServer.address(); assert.ok(address && typeof address !== "string");
  const f = await memoryFixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "tool") answer(res, String(last.content));
    else if (last.content === "有何作息规律") answer(res, "", { name: "memory_search", args: { query: "有何作息规律" } });
    else answer(res, "已处理");
  }, {
    embedding: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-embed", apiKey: "secret", timeoutMs: 100 },
  });
  await f.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "sleep", text: "我的睡眠时间是晚上十一点" });
  await f.send("/reset"); await f.send("启动索引");
  for (let tick = 0; tick < 100 && !indexed.has("我的睡眠时间是晚上十一点"); tick++) await new Promise((resolve) => setTimeout(resolve, 10));
  await f.send("有何作息规律");
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /我的睡眠时间是晚上十一点/);
  assert.match(f.sent.at(-1)!, /dense/);
  assert.equal(JSON.parse(f.sent.at(-1)!)[0].similarity, 1);
  const before = requests; await f.send("有何作息规律");
  assert.ok(requests - before < 3);
  assert.doesNotMatch(JSON.stringify(await f.rootLog.read()), /secret/);
});

test("embedding timeout preserves literal recall and records a safe degradation", async (t) => {
  const stalled = createServer((_req, _res) => {});
  await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { stalled.closeAllConnections(); stalled.close(() => resolve()); }));
  const address = stalled.address(); assert.ok(address && typeof address !== "string");
  const f = await memoryFixture(t, (_data, res) => answer(res, "答复"), {
    embedding: { baseUrl: `http://127.0.0.1:${address.port}`, model: "test", apiKey: "private-key", timeoutMs: 30 },
  });
  await f.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "old", text: "limboo 是战士" });
  await f.send("/reset");
  const started = performance.now(); await f.send("limboo");
  assert.ok(performance.now() - started < 1000);
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /limboo 是战士/);
  const events = await f.rootLog.read(); assert.ok(events.some((e) => e.type === "memory_recalled" && e.degraded === "embedding_unavailable"));
  assert.doesNotMatch(JSON.stringify(events), /private-key/);
});

async function embeddingService(t: TestContext, respond: (input: string[], model: string, res: ServerResponse) => void) {
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); respond(data.input, data.model, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
function embeddingResponse(res: ServerResponse, input: string[], vector: number[]) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: vector })) }));
}
async function eventually(predicate: () => boolean | Promise<boolean>) {
  for (let tick = 0; tick < 200 && !await predicate(); tick++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(await predicate());
}

test("background embedding batches recover without another query and skip newly excluded nodes", async (t) => {
  let available = false; const inputs: string[][] = [];
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    inputs.push(input);
    if (!available) { res.writeHead(503); res.end(); }
    else embeddingResponse(res, input, [1, 0]);
  });
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), {
    embedding: { baseUrl, model: "retry", apiKey: "test", timeoutMs: 100 },
  });
  for (let index = 0; index < 6; index++) await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: `retry-${index}`, text: `待索引原话${index}` });
  await fixture.send("触发");
  await eventually(() => inputs.some((batch) => batch.length > 1));
  await fixture.rootLog.append({ type: "memory_excluded", nodeId: "retry-3" });
  const boundary = inputs.length; available = true;
  await eventually(() => inputs.slice(boundary).some((batch) => batch.includes("待索引原话5")));
  assert.ok(inputs.slice(boundary).every((batch) => !batch.includes("待索引原话3")));
  await fixture.send("/reset"); await fixture.send("查询");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /待索引原话5/);
  assert.doesNotMatch(JSON.stringify(fixture.seen.at(-1)!.messages), /待索引原话3/);
});

test("long Unicode embeddings and turn vectors are cached in dimension and model namespaces", async (t) => {
  let dimension = 2; const inputs: string[][] = [];
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    inputs.push(input); embeddingResponse(res, input, Array.from({ length: dimension }, (_value, index) => index === 0 ? 1 : 0));
  });
  const config = { baseUrl, model: "first", apiKey: "test", maxInputChars: 4, timeoutMs: 1000 };
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), { embedding: config });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "unicode", text: "🎮".repeat(19) });
  await fixture.send("/reset"); await fixture.send("启动");
  await eventually(() => inputs.flat().includes("🎮".repeat(3)));
  await fixture.send("异义");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /🎮/);
  assert.ok(inputs.flat().every((text) => Array.from(text).length <= 4));
  const before = inputs.length;
  dimension = 3; await fixture.send("维度切换");
  await eventually(() => inputs.slice(before).flat().includes("🎮".repeat(3)));
  await fixture.send("/reset"); await fixture.send("另一问");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /🎮/);
  const afterDimension = inputs.length; config.model = "second"; await fixture.restart(); await fixture.send("新模型");
  await eventually(() => inputs.slice(afterDimension).flat().includes("🎮".repeat(3)));
  await fixture.send("/reset"); await fixture.send("再一问");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /🎮/);
});

test("invalid zero vectors degrade safely and recover in the background", async (t) => {
  let valid = false; let filled = false;
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    if (valid && input.includes("旧记忆")) filled = true;
    embeddingResponse(res, input, valid ? [1, 0] : [0, 0]);
  });
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), {
    embedding: { baseUrl, model: "invalid", apiKey: "test", timeoutMs: 100 },
  });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "invalid", text: "旧记忆" });
  await fixture.send("/reset"); await fixture.send("旧记忆");
  assert.ok((await fixture.rootLog.read()).some((event) => event.type === "memory_recalled" && event.degraded === "embedding_unavailable"));
  valid = true; await eventually(() => filled);
  await fixture.send("改写查询");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /旧记忆/);
});

test("a JSON message cannot collide with a cached turn embedding", async (t) => {
  const indexed = new Set<string>();
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    input.forEach((text) => indexed.add(text));
    res.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: text.startsWith("{") ? [0, 1] : [1, 0] })) }));
  });
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), { embedding: { baseUrl, model: "collision", apiKey: "test" } });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "hello", text: "hello" });
  await fixture.send("索引"); await eventually(() => indexed.has("hello"));
  await fixture.send("读一次"); await fixture.send("/reset");
  await fixture.send('{"turn":["hello"]}');
  assert.ok(indexed.has('{"turn":["hello"]}'));
  const snapshot = (await fixture.rootLog.read()).findLast((event) => event.type === "memory_recalled")!;
  const candidate = (snapshot.candidates as Array<{ nodeId: string; sources: string[] }>).find((item) => item.nodeId === "hello")!;
  assert.ok(candidate.sources.includes("literal"));
  assert.ok(!candidate.sources.includes("dense"));
});

test("background long-message indexing is not limited by the foreground total timeout", async (t) => {
  let completed = 0;
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    setTimeout(() => { embeddingResponse(res, input, [1, 0]); completed++; }, 20);
  });
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), {
    embedding: { baseUrl, model: "long", apiKey: "test", maxInputChars: 4, timeoutMs: 60 },
  });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "slow-long", text: "🪐".repeat(192) });
  await fixture.send("索引"); await eventually(() => completed >= 4);
  await fixture.send("/reset"); await fixture.send("异义");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /🪐/);
});

test("delivery reinforces only the automatic top eight actually shown and restart never repeats it", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), { memoryBudget: { maxTokens: 1500 } });
  for (let index = 0; index < 12; index++) await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: `activation-${index}`, text: `limboo 战士${index}` });
  await fixture.send("/reset"); await fixture.send("limboo");
  const events = await fixture.rootLog.read();
  const snapshot = events.findLast((event) => event.type === "memory_recalled")!;
  const shown = events.findLast((event) => event.type === "memory_presented")!.shown as Array<{ nodeId: string }>;
  assert.ok(shown.length > 8);
  const learning = events.filter((event) => event.type === "memory_learned" && event.requestId === snapshot.requestId);
  assert.equal(learning.length, 1);
  const expected = (snapshot.candidates as Array<{ nodeId: string }>).slice(0, 8).map((candidate) => candidate.nodeId);
  assert.deepEqual((learning[0]!.activated as Array<{ nodeId: string }>).map((candidate) => candidate.nodeId), expected);
  await fixture.restart(); await fixture.restart();
  assert.equal((await fixture.rootLog.read()).filter((event) => event.type === "memory_learned" && event.requestId === snapshot.requestId).length, 1);
});

test("unshown top-eight candidates are skipped without substituting the ninth", async (t) => {
  const fixture = await memoryFixture(t, (data, res) => {
    if (data.messages.at(-1)!.role === "tool") answer(res, "答复");
    else answer(res, "", { name: "memory_search", args: { query: "private_ninth", limit: 1 } });
  }, { memoryBudget: { maxTokens: 350 } });
  for (let index = 0; index < 9; index++) await fixture.rootLog.append({ type: "message", role: "user", chatId: 42,
    requestId: `unshown-${index === 8 ? 9 : index}`, text: index === 8 ? "limboo private_ninth" : `limboo rare_private ${index}` });
  await fixture.send("/reset"); await fixture.send("limboo rare_private");
  const events = await fixture.rootLog.read();
  assert.equal((events.findLast((event) => event.type === "memory_recalled")!.candidates as Array<{ nodeId: string }>)[8]!.nodeId, "unshown-9");
  const activated = events.findLast((event) => event.type === "memory_learned")!.activated as Array<{ nodeId: string }>;
  assert.ok(activated.length > 0 && activated.length < 8);
  assert.ok(!activated.some((item) => item.nodeId === "unshown-9"));
  assert.ok(events.some((event) => event.type === "memory_presented" && (event.shown as Array<{ nodeId: string }>).some((item) => item.nodeId === "unshown-9")));
});

test("failed current final delivery does not reinforce recalled memory", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), {}, {
    createTransport: (api) => createTelegramRichTransport({ ...api, sendRich: async (chatId, text, signal) => {
      if (text === "答复") throw new Error("transport failure");
      return api.sendRich(chatId, text, signal);
    } }),
  });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "old-failure", text: "limboo" });
  await fixture.send("limboo", { messageId: 100 });
  const events = await fixture.rootLog.read();
  assert.ok(events.some((event) => event.type === "run_succeeded"));
  assert.ok(events.some((event) => event.type === "telegram_delivery_unknown"));
  assert.ok(!events.some((event) => event.type === "delivery_succeeded" || event.type === "memory_learned"));
});
test("late delivered messages and vector-cache removal never rewrite learned initialization", async (t) => {
  const indexed = new Set<string>();
  const now = Date.now() + 60_000;
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    input.forEach((text) => indexed.add(text));
    res.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: text.includes("surgery") ? [0, 1] : [1, 0] })) }));
  });
  let inspecting = false;
  const fixture = await memoryFixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "tool") answer(res, String(last.content));
    else if (last.content === "查状态") answer(res, "", { name: "memory_search", args: { query: "limboo" } });
    else answer(res, "答复");
  }, { embedding: { baseUrl, model: "frozen", apiKey: "test" }, memoryNow: () => now }, {
    createTransport: (api) => createTelegramRichTransport({ ...api, sendRich: async (chatId, text, signal) => {
      if (inspecting && text.startsWith("[")) throw new Error("inspection not delivered");
      return api.sendRich(chatId, text, signal);
    } }),
  });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "frozen", text: "limboo daily" });
  await fixture.send("索引"); await eventually(() => indexed.has("limboo daily"));
  await fixture.send("limboo");
  const initial = (await fixture.rootLog.read()).find((event) => event.type === "memory_initialized" && event.nodeId === "frozen")!;
  assert.equal(initial.salience, 0);
  await fixture.rootLog.append({ type: "text_finalized", requestId: "frozen", textSegmentId: "late-frozen", contentKind: "final", text: "surgery" });
  await fixture.rootLog.append({ type: "delivery_succeeded", requestId: "frozen" });
  await fixture.send("查状态"); await eventually(() => indexed.has("surgery"));
  const inspect = async (messageId: number) => {
    inspecting = true;
    try { await fixture.send("查状态", { messageId }); } finally { inspecting = false; }
    const output = fixture.seen.at(-1)!.messages.findLast((message) => message.role === "tool")!;
    return JSON.parse(String(output.content)).find((item: { nodeId: string }) => item.nodeId === "frozen").state;
  };
  const state = await inspect(1000);
  assert.equal(state.salience, 0);
  assert.ok(state.resource < 1);
  assert.ok(state.strength > 2.1 * Math.exp(-(now - Number(initial.initializedAt)) / (7 * 86400_000)));
  await fixture.restart(["memory.sqlite", "embeddings.sqlite"]);
  const rebuilt = await inspect(1001);
  assert.equal(rebuilt.salience, 0);
  assert.equal(rebuilt.strength, state.strength); assert.equal(rebuilt.resource, state.resource);
  assert.equal((await fixture.rootLog.read()).filter((event) => event.type === "memory_initialized" && event.nodeId === "frozen").length, 1);
});

test("existing original context qualifies for learning but summary-only history does not", async (t) => {
  const summary = "## Goal\nContinue.\n## Progress\nPast limboo discussion.\n## Constraints\nPreserve evidence.\n## Decisions\nUse sources.\n## Next Steps\nAnswer.\n## Critical Context\nSummary is lossy.";
  const fixture = await memoryFixture(t, (data, res) => {
    if (JSON.stringify(data.messages).includes("HISTORY_COMPACTION")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: summary }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    } else answer(res, "答复");
  }, { contextWindow: 12000, compaction: { trigger: 0.8, target: 0.7, recentTokens: 3000, summaryTokens: 500 }, memoryBudget: { maxTokens: 0 } });
  for (let index = 0; index < 5; index++) {
    const requestId = `summary-source-${index}`;
    await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId, text: `limboo original_marker_${index} ` + "x".repeat(4000) });
    await fixture.rootLog.append({ type: "answer_generated", requestId, text: "y".repeat(4000) });
    await fixture.rootLog.append({ type: "delivery_succeeded", requestId });
    await fixture.rootLog.append({ type: "request_completed", requestId });
  }
  await fixture.send("limboo");
  const events = await fixture.rootLog.read();
  const shown = events.findLast((event) => event.type === "memory_presented")!.shown as Array<{ nodeId: string; existing: boolean }>;
  const activated = events.findLast((event) => event.type === "memory_learned")!.activated as Array<{ nodeId: string }>;
  assert.ok(shown.length > 0 && shown.every((item) => item.existing));
  assert.ok(activated.length > 0 && activated.length < 5);
  assert.deepEqual(new Set(activated.map((item) => item.nodeId)), new Set(shown.map((item) => item.nodeId)));
  for (const reference of shown) assert.match(JSON.stringify(fixture.seen.at(-1)!.messages),
    new RegExp(`original_marker_${reference.nodeId.split("-").at(-1)}`), "only actually visible originals qualify as memory presentations");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /历史摘要/);
});

test("learned local associations inject original background without a literal match", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"));
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "game", text: "limboo 是我的朋友" });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "care", text: "引流条每天换药" });
  await fixture.send("limboo 引流条");
  await fixture.send("/reset"); await fixture.send("limboo 最近怎样");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /引流条每天换药/);
  const candidates = (await fixture.rootLog.read()).findLast((event) => event.type === "memory_recalled")!.candidates as Array<{ nodeId: string; sources: string[] }>;
  assert.ok(candidates.find((item) => item.nodeId === "care")!.sources.includes("local"));
});

test("multiple learned seed paths discover far-field background and excluded nodes cannot bridge", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"));
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "far-care", at: new Date(Date.now() - 3 * 86400_000).toISOString(), text: "引流条每天换药" });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "far-game", text: "limboo 是我的朋友" });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "far-family", text: "舍友和我联机" });
  await fixture.send("limboo 舍友 引流条");
  await fixture.send("/reset"); await fixture.send("limboo 舍友 最近怎样");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /引流条每天换药/);
  const snapshot = (await fixture.rootLog.read()).findLast((event) => event.type === "memory_recalled")!;
  const distant = (snapshot.candidates as Array<{ nodeId: string; sources: string[]; paths: string[][] }>).find((item) => item.nodeId === "far-care")!;
  assert.ok(distant.sources.includes("far")); assert.ok(!distant.sources.includes("local"));
  assert.ok(new Set(distant.paths.map((path) => path[0])).size >= 2);
  await fixture.rootLog.append({ type: "memory_excluded", nodeId: "far-care" });
  await fixture.send("/reset"); await fixture.send("limboo 舍友 最近怎样");
  assert.doesNotMatch(JSON.stringify(fixture.seen.at(-1)!.messages), /引流条每天换药/);
});

test("a greeting hub and unrelated noise cannot outrank a direct personal-name fact", async (t) => {
  const fixture = await memoryFixture(t, (data, res) => {
    if (data.messages.at(-1)!.role === "tool") answer(res, String(data.messages.at(-1)!.content));
    else answer(res, "", { name: "memory_search", args: { query: "limboo", limit: 20 } });
  }, { memoryRecall: { maxLocalNodes: 16, iterations: 3, maxTransitions: 4 } });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "specific", text: "limboo 是我的朋友" });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "hub", text: "你好 晚安" });
  const dynamics = { strengthMs: 7 * 86400_000, edgeMs: 14 * 86400_000, resourceMs: 30 * 60_000, strengthCap: 3, edgeCap: 2,
    strengthRate: 0.18, resourceRate: 0.35, edgeRate: 0.12, backwardRatio: 0.25 };
  for (let index = 0; index < 24; index++) {
    await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: `noise-${index}`, text: "不相关背景" });
    await fixture.rootLog.append({ type: "memory_learned", requestId: `noise-${index}`, userId: 42, algorithm: "akasha-v1", origin: "online", settledAt: new Date().toISOString(), dynamics,
      activated: [{ nodeId: "hub", signal: 0.7, score: 2 }, ...(index === 0 ? [{ nodeId: "specific", signal: 0.7, score: 2 }] : [])] });
  }
  await fixture.send("/reset"); await fixture.send("查询名字");
  const results = JSON.parse(fixture.sent.at(-1)!) as Array<{ nodeId: string; score: number; paths: string[][] }>;
  assert.equal(results[0]!.nodeId, "specific");
  assert.ok(results.every((item) => Number.isFinite(item.score) && item.score >= 0));
  assert.ok(results.every((item) => item.paths.length <= 4 && item.paths.every((path) => path.length <= 4)));
});

test("explicit forgetting filters later context and memory, preserves raw inspection, and permits new same-topic information", async (t) => {
  const fixture = await memoryFixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "tool") answer(res, "已查询");
    else if (last.content === "查 limboo") answer(res, "", { name: "memory_search", args: { query: "limboo" } });
    else answer(res, "答复");
  });
  await fixture.send("limboo 原始秘密alpha");
  const nodeId = (await fixture.rootLog.read()).find((event) => event.type === "message" && event.role === "user")!.requestId!;
  const calls = fixture.seen.length;
  await fixture.send(`/forget ${nodeId}`);
  assert.equal(fixture.seen.length, calls);
  assert.equal((await fixture.rootLog.read()).filter((event) => event.type === "memory_excluded" && event.nodeId === nodeId).length, 1);
  await fixture.send("查 limboo");
  assert.doesNotMatch(JSON.stringify(fixture.seen.at(-1)!.messages), /原始秘密alpha/);
  await fixture.send(`/memory log ${nodeId}`);
  assert.match(fixture.sent.at(-1)!, /原始秘密alpha/);
  assert.match(fixture.sent.at(-1)!, /不恢复/);
  await fixture.send("/reset"); await fixture.restart(["memory.sqlite", "embeddings.sqlite"]);
  await fixture.send("limboo 重新建立的新约定beta"); await fixture.send("查 limboo");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /新约定beta/);
  assert.doesNotMatch(JSON.stringify(fixture.seen.at(-1)!.messages), /原始秘密alpha/);
  assert.ok((await fixture.rootLog.read()).some((event) => event.type === "message" && event.text === "limboo 原始秘密alpha"));
});

test("reply-based forgetting locates both user and delivered assistant turns, and duplicate inputs stay idempotent", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"));
  await fixture.send("用户回复目标alpha", { messageId: 301 });
  await fixture.send("/forget", { messageId: 302, replyToMessageId: 301 });
  await fixture.send("助手回复目标beta", { messageId: 303 });
  const delivery = (await fixture.rootLog.read()).findLast((event) => event.type === "telegram_delivery_succeeded")!;
  const metadata = { messageId: 304, replyToMessageId: Number(delivery.telegramMessageId) };
  await fixture.send("/forget", metadata); await fixture.send("/forget", metadata);
  const events = await fixture.rootLog.read();
  const excluded = events.filter((event) => event.type === "memory_excluded");
  assert.equal(excluded.length, 2); assert.equal(new Set(excluded.map((event) => event.nodeId)).size, 2);
  assert.ok(excluded.every((event) => event.replyToMessageId !== undefined));
  const count = events.length; const calls = fixture.seen.length;
  await fixture.sendUpdate({ update_id: 999, message: { message_id: 305, date: 0,
    from: { id: 999, is_bot: false, first_name: "stranger" }, chat: { id: 999, type: "private", first_name: "stranger" },
    text: "/forget", reply_to_message: { message_id: Number(delivery.telegramMessageId), date: 0,
      chat: { id: 999, type: "private", first_name: "stranger" }, reply_to_message: undefined } } });
  assert.equal((await fixture.rootLog.read()).length, count);
  assert.equal(fixture.seen.length, calls);
  await fixture.send("后续正常问题", { messageId: 306 });
  assert.doesNotMatch(JSON.stringify(fixture.seen.at(-1)!.messages), /用户回复目标alpha|助手回复目标beta/);
});
test("ambiguous forgetting only offers confirmation candidates and old memory tool results are filtered with valid pairing", async (t) => {
  const fixture = await memoryFixture(t, (data, res) => {
    if (data.messages.at(-1)!.role === "tool") answer(res, "已查询");
    else if (data.messages.at(-1)!.content === "查旧事") answer(res, "", { name: "memory_search", args: { query: "limboo" } });
    else answer(res, "答复");
  });
  await fixture.send("limboo 私密旧事实alpha"); await fixture.send("查旧事");
  const target = (await fixture.rootLog.read()).find((event) => event.type === "message" && event.text === "limboo 私密旧事实alpha")!.requestId!;
  await fixture.send("/forget limboo");
  assert.equal((await fixture.rootLog.read()).some((event) => event.type === "memory_excluded"), false);
  assert.match(fixture.sent.at(-1)!, /没有执行排除/);
  await fixture.send(`/forget ${target}`); await fixture.send("不相关的新问题");
  const context = fixture.seen.at(-1)!.messages;
  assert.doesNotMatch(JSON.stringify(context), /私密旧事实alpha/);
  assert.ok(context.some((message) => message.role === "tool"));
  assert.ok(context.some((message) => message.role === "assistant"));
});

test("excluded memory cannot return through archived read results including recursive and legacy reads", async (t) => {
  let archivePath = "";
  const fixture = await memoryFixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "tool") answer(res, "查询完成");
    else if (last.content === "查旧事归档") answer(res, "", { name: "memory_search", args: { query: "limboo" } });
    else if (last.content === "读来源归档") answer(res, "", { name: "read", args: { path: archivePath } });
    else answer(res, "答复");
  });
  await fixture.send("limboo archive_sensitive"); await fixture.send("查旧事归档");
  let events = await fixture.rootLog.read();
  const target = events.find((event) => event.type === "message" && event.text === "limboo archive_sensitive")!.requestId!;
  archivePath = (events.findLast((event) => event.type === "tool_result")!.archive as { path: string }).path;
  await fixture.send("读来源归档");
  events = await fixture.rootLog.read();
  archivePath = "@" + relative(fixture.dir, (events.findLast((event) => event.type === "tool_result" && (event.result as { details?: { sourceToolName?: string } })?.details?.sourceToolName === "memory_search")!.archive as { rawPath: string }).rawPath);
  if (process.platform === "win32") archivePath = archivePath.toUpperCase();
  await fixture.send("读来源归档");
  events = await fixture.rootLog.read();
  const oldRead = events.findLast((event) => event.type === "tool_result" && event.toolName === "read")!;
  const oldModel = events.findLast((event) => event.type === "model_message" && event.requestId === oldRead.requestId &&
    (event.message as { content: Array<{ type: string }> }).content.some((part) => part.type === "toolCall"))!;
  const legacyResult = { ...(oldRead.result as ToolResult), details: {} };
  // Preserve the copied older writer payload through the raw reader, without adding current identity fields.
  const at = new Date().toISOString();
  const oldFacts = [
    { type: "message", role: "user", chatId: 42, requestId: "legacy-read", text: "旧版来源查询", at },
    { type: "model_message", requestId: "legacy-read", message: oldModel.message, at },
    { type: "tool_dispatch", requestId: "legacy-read", toolCallId: oldRead.toolCallId, toolName: "read", args: { path: archivePath }, at },
    { type: "tool_result", requestId: "legacy-read", toolCallId: oldRead.toolCallId, toolName: "read", result: legacyResult,
      archive: await fixture.rootLog.archive(legacyResult), at },
    { type: "request_completed", requestId: "legacy-read", at },
  ];
  // An independent raw historical writer preserves missing identity fields. Current
  // activity starts and their prefix digests are not re-imported as old source facts.
  const legacyLog = createSqliteRuntimeLog(fixture.dir, { fileName: "legacy-archive-history.sqlite" });
  for (const event of events.filter((event) => event.type === "tool_result")) {
    const { eventId: _identity, sequence: _sequence, schemaVersion: _schema, ...source } = event;
    await legacyLog.append(source);
  }
  for (const event of oldFacts) await legacyLog.append(event);
  await legacyLog.append({ type: "message", role: "user", chatId: 42, requestId: "legacy-probe", text: "兼容读取" });
  const copied = (await legacyLog.read()).find((event) => event.type === "model_message" && event.requestId === "legacy-read")!;
  assert.equal(copied.modelStepId, undefined, "missing old model-step identity is preserved");
  assert.equal(copied.conversationId, undefined, "legacy ownership is interpreted from durable chat identity");
  const model = getModel("deepseek", "deepseek-v4-flash");
  const oldReplay = await replayEvents(legacyLog, "legacy-probe", model);
  assert.match(JSON.stringify(oldReplay.units), /archive_sensitive/);
  archivePath = (oldRead.archive as { path: string }).path;
  await fixture.send("读来源归档");
  await fixture.send(`/forget ${target}`); await fixture.send("普通新问题");
  assert.equal(fixture.failures.length, 0, JSON.stringify(fixture.failures.map((error) => error instanceof Error ? { message: error.message, stack: error.stack } : error)));
  assert.deepEqual((await fixture.rootLog.read()).filter((event) => event.type === "run_failed").map((event) => ({ error: event.error, requestId: event.requestId })), []);
  assert.doesNotMatch(JSON.stringify(fixture.seen.at(-1)!.messages), /archive_sensitive/);
  const pairs = fixture.seen.at(-1)!.messages as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
  const calls = pairs.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []);
  const results = pairs.flatMap((message) => message.role === "tool" && message.tool_call_id ? [message.tool_call_id] : []);
  assert.ok(results.length > 3, "current continuous replay retains complete exchanges beyond the retired three-turn window");
  assert.deepEqual(results.slice().sort(), calls.slice().sort(), "every retained tool exchange remains completely paired");
  await fixture.restart(); await fixture.send("重启后新问题");
  const restored = fixture.seen.at(-1)!.messages as typeof pairs;
  assert.doesNotMatch(JSON.stringify(restored), /archive_sensitive/);
  assert.deepEqual(restored.flatMap((message) => message.role === "tool" && message.tool_call_id ? [message.tool_call_id] : []), results);
  await legacyLog.append({ type: "memory_excluded", nodeId: target });
  const reopened = createSqliteRuntimeLog(fixture.dir, { fileName: "legacy-archive-history.sqlite" });
  const filtered = await replayEvents(reopened, "legacy-probe", model);
  assert.doesNotMatch(JSON.stringify(filtered.units), /archive_sensitive/);
  const oldPair = filtered.units.flatMap((unit) => unit.messages).filter((message) => message.role === "toolResult");
  assert.equal(oldPair.length, 1, "the legacy pair survives with its result redacted");
  assert.equal(oldPair[0]!.toolCallId, oldRead.toolCallId);
  assert.match(JSON.stringify(oldPair), /已排除/);
});

test("replying to a confirmed page of a partially delivered final can exclude its user turn", async (t) => {
  let sends = 0;
  const fixture = await memoryFixture(t, (_data, res) => answer(res, Array.from({ length: 1200 }, (_, index) => `多页正文 ${index}`).join("\n\n")), {}, {
    createTransport: (api) => createTelegramRichTransport({ ...api, sendRich: async (chatId, text, signal) => {
      if (text.startsWith("多页正文") && ++sends === 2) throw new Error("second page unavailable");
      return api.sendRich(chatId, text, signal);
    } }),
  });
  await fixture.send("部分送达目标", { messageId: 410 });
  const events = await fixture.rootLog.read();
  const delivered = events.find((event) => event.type === "telegram_delivery_succeeded")!;
  assert.ok(delivered); assert.equal(delivered.partIndex, 0);
  assert.ok(events.some((event) => event.type === "telegram_delivery_unknown" && event.partIndex === 1));
  assert.ok(!events.some((event) => event.type === "delivery_succeeded"));
  await fixture.send("/forget", { messageId: 411, replyToMessageId: Number(delivered.telegramMessageId) });
  assert.ok((await fixture.rootLog.read()).some((event) => event.type === "memory_excluded" && event.nodeId === delivered.requestId));
});
test("archive source exclusion survives removal of a previously verified directory alias", async (t) => {
  let path = "";
  const fixture = await memoryFixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "tool") answer(res, "已读取");
    else if (last.content === "查来源") answer(res, "", { name: "memory_search", args: { query: "limboo" } });
    else if (last.content === "读别名") answer(res, "", { name: "read", args: { path } });
    else answer(res, "答复");
  });
  await fixture.send("limboo alias_sensitive"); await fixture.send("查来源");
  const events = await fixture.rootLog.read();
  const target = events.find((event) => event.type === "message" && event.text === "limboo alias_sensitive")!.requestId!;
  const archive = events.findLast((event) => event.type === "tool_result")!.archive as { path: string };
  const alias = join(fixture.dir, "archive-alias");
  await symlink(join(fixture.dir, "tool-results"), alias, process.platform === "win32" ? "junction" : "dir");
  path = join(alias, relative(join(fixture.dir, "tool-results"), archive.path));
  await fixture.send("读别名");
  await fixture.send(`/forget ${target}`);
  await rm(alias); await fixture.restart(); await fixture.send("无关新问题");
  assert.doesNotMatch(JSON.stringify(fixture.seen.at(-1)!.messages), /alias_sensitive/);
});

test("a password question or natural forgetting sentence stays model input without authorizing exclusion", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"));
  await fixture.send("账号凭据旧约定", { messageId: 401 });
  await fixture.send("忘记密码怎么办？", { messageId: 402, replyToMessageId: 401 });
  assert.equal((await fixture.rootLog.read()).some((event) => event.type === "memory_excluded"), false);
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /忘记密码怎么办/);
  const calls = fixture.seen.length;
  await fixture.send("忘掉账号", { messageId: 403, replyToMessageId: 401 });
  assert.equal(fixture.seen.length, calls + 1);
  assert.equal((await fixture.rootLog.read()).some((event) => event.type === "memory_excluded"), false);
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /忘掉账号/);
});
test("forgetting invalidates affected summaries and regenerates them only from remaining original facts", async (t) => {
  let summaries = 0;
  const fixture = await memoryFixture(t, (data, res) => {
    if (JSON.stringify(data.messages).includes("HISTORY_COMPACTION")) {
      summaries++;
      const sensitive = JSON.stringify(data.messages).includes("alpha_sensitive");
      const summary = `## Goal\nContinue.\n## Progress\nEarlier work.\n## Constraints\nKeep evidence.\n## Decisions\nUse sources.\n## Next Steps\nAnswer.\n## Critical Context\n${sensitive ? "alpha_sensitive" : "remaining clean facts"}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: summary }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    } else answer(res, "答复");
  }, { contextWindow: 12000, compaction: { trigger: 0.65, target: 0.6, recentTokens: 3000, summaryTokens: 500 }, memoryBudget: { maxTokens: 0 } });
  for (let index = 0; index < 5; index++) {
    await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: `forget-summary-${index}`, text: `${index === 2 ? "alpha_sensitive" : "other"} ` + "x".repeat(4500) });
    await fixture.rootLog.append({ type: "answer_generated", requestId: `forget-summary-${index}`, text: "y".repeat(4500) });
    await fixture.rootLog.append({ type: "delivery_succeeded", requestId: `forget-summary-${index}` });
    await fixture.rootLog.append({ type: "request_completed", requestId: `forget-summary-${index}` });
  }
  await fixture.send("继续"); const before = summaries; assert.ok(before > 0);
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /alpha_sensitive/);
  await fixture.send("/forget forget-summary-2"); await fixture.send("再继续");
  assert.ok(summaries > before);
  assert.doesNotMatch(JSON.stringify(fixture.seen.at(-1)!.messages), /alpha_sensitive/);
});

test("corrupt and incompatible derived caches rebuild frozen learning and exclusions without changing original facts", async (t) => {
  const now = Date.now() + 60_000;
  const baseUrl = await embeddingService(t, (input, _model, res) => embeddingResponse(res, input, [1, 0]));
  let inspecting = false;
  const fixture = await memoryFixture(t, (data, res) => {
    if (data.messages.at(-1)!.role === "tool") answer(res, String(data.messages.at(-1)!.content));
    else if (data.messages.at(-1)!.content === "查状态") answer(res, "", { name: "memory_search", args: { query: "limboo" } });
    else answer(res, "答复");
  }, { embedding: { baseUrl, model: "repair", apiKey: "test" }, memoryNow: () => now }, {
    createTransport: (api) => createTelegramRichTransport({ ...api, sendRich: async (chatId, text, signal) => {
      if (inspecting && text.startsWith("[")) throw new Error("inspection not delivered");
      return api.sendRich(chatId, text, signal);
    } }),
  });
  await fixture.send("limboo 保留的原话");
  await fixture.send("limboo 后续关联");
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "repair-excluded", text: "limboo 排除的原话" });
  await fixture.send("/forget repair-excluded");
  const target = (await fixture.rootLog.read()).find((event) => event.type === "message" && event.text === "limboo 保留的原话")!.requestId!;
  const inspect = async (messageId: number) => {
    inspecting = true;
    try { await fixture.send("查状态", { messageId }); } finally { inspecting = false; }
    const items = JSON.parse(String(fixture.seen.at(-1)!.messages.findLast((message) => message.role === "tool")!.content));
    assert.ok(items.every((item: { nodeId: string }) => item.nodeId !== "repair-excluded"));
    return items.find((item: { nodeId: string }) => item.nodeId === target).state;
  };
  const state = await inspect(600);
  const facts = (await fixture.rootLog.read()).filter((event) => ["memory_initialized", "memory_learned", "memory_excluded"].includes(event.type));
  await fixture.restart([], async () => {
    for (const name of ["memory.sqlite", "embeddings.sqlite"]) await writeFile(join(fixture.dir, name), "not a SQLite database");
  });
  assert.deepEqual(await inspect(601), state);
  await fixture.restart([], async () => {
    for (const name of ["memory.sqlite", "embeddings.sqlite"]) {
      const db = new DatabaseSync(join(fixture.dir, name));
      try { db.exec("PRAGMA user_version=999; DROP TABLE IF EXISTS memory_nodes; CREATE TABLE memory_nodes (wrong TEXT)"); } finally { db.close(); }
    }
  });
  assert.deepEqual(await inspect(602), state);
  await fixture.restart([], async () => {
    const db = new DatabaseSync(join(fixture.dir, "memory.sqlite"));
    try { db.exec("DROP TABLE memory_nodes; CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, payload TEXT NOT NULL) WITHOUT ROWID"); } finally { db.close(); }
  });
  assert.deepEqual(await inspect(603), state);
  assert.deepEqual((await fixture.rootLog.read()).filter((event) => ["memory_initialized", "memory_learned", "memory_excluded"].includes(event.type)), facts);
  assert.ok((await fixture.rootLog.read()).some((event) => event.type === "message" && event.text === "limboo 排除的原话"));
});

test("pure dense comparison uses identical synthetic originals, vectors, time and budgets with grounded coverage and error metrics", async (t) => {
  let embeddingRequests = 0;
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    embeddingRequests++;
    res.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: evaluationVector(text) })) }));
  });
  for (const scenario of evaluationCases) for (const mode of ["dense", "akasha"] as const) {
    const started = performance.now();
    const requestsBefore = embeddingRequests;
    const budget = scenario.budget ?? 900;
    const fixture = await memoryFixture(t, (_data, res) => answer(res, "评估完成"), {
      memoryMode: mode, memoryNow: () => scenario.now ?? EVALUATION_NOW, memoryBudget: { maxTokens: budget }, contextWindow: 18000,
      embedding: { baseUrl, model: "synthetic-fixed-v1", apiKey: "synthetic" },
    }, {}, async (dir) => {
      const embedding = createEmbeddingClient(dir, { baseUrl, model: "synthetic-fixed-v1", apiKey: "synthetic" });
      try { for (const item of evaluationCorpus.filter((item) => !item.excluded)) {
        await embedding.get(item.text); if (item.assistant) await embedding.get(item.assistant);
      } } finally { await embedding.close(); }
    });
    for (const item of evaluationCorpus) {
      const at = EVALUATION_START + item.minutes * 60_000;
      await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: item.id, text: item.text, at: new Date(at).toISOString() });
      if (item.assistant) {
        await fixture.rootLog.append({ type: "text_finalized", requestId: item.id, textSegmentId: `${item.id}:final`, contentKind: "final", text: item.assistant, at: new Date(at + 100).toISOString() });
        await fixture.rootLog.append({ type: "delivery_succeeded", requestId: item.id, at: new Date(at + 200).toISOString() });
      }
      await fixture.rootLog.append({ type: "request_completed", requestId: item.id, at: new Date(at + 300).toISOString() });
      await fixture.rootLog.append({ type: "memory_initialized", nodeId: item.id, userId: 42, algorithm: "akasha-v1", salience: 0, strength: 2.1, initializedAt: at });
      if (item.activated) await fixture.rootLog.append({ type: "memory_learned", origin: "online", requestId: item.id, userId: 42, algorithm: "akasha-v1", settledAt: new Date(at + 300).toISOString(),
        dynamics: DEFAULT_DYNAMICS, activated: item.activated.map((nodeId) => ({ nodeId, signal: 1 })) });
      if (item.excluded) await fixture.rootLog.append({ type: "memory_excluded", nodeId: item.id, userId: 42 });
    }
    await eventually(() => evaluationCorpus.filter((item) => !item.excluded).every((item) => fixture.memoryVector(item.text) && (!item.assistant || fixture.memoryVector(item.assistant))));
    await fixture.send("/reset");
    const queryStarted = performance.now();
    const queryRequests = embeddingRequests;
    await fixture.send(scenario.query);
    const elapsedMs = performance.now() - queryStarted;
    const events = await fixture.rootLog.read();
    const recalled = events.findLast((event) => event.type === "memory_recalled")!;
    const presented = events.findLast((event) => event.type === "memory_presented")!;
    const shown = new Set((presented.shown as Array<{ nodeId: string }>).map((item) => item.nodeId));
    const top8 = (recalled.candidates as Array<{ nodeId: string }>).slice(0, 8).map((item) => item.nodeId);
    const allowed = [...scenario.required, ...scenario.background];
    const covered = scenario.required.filter((nodeId) => shown.has(nodeId)).length;
    const background = scenario.background.filter((nodeId) => shown.has(nodeId)).length;
    const errors = [...shown].filter((nodeId) => !allowed.includes(nodeId));
    if (mode === "akasha") assert.equal(covered, scenario.required.length, scenario.name);
    const payload = fixture.seen.at(-1)!;
    const wireInputTokens = Math.ceil(Buffer.byteLength(JSON.stringify({ messages: payload.messages, tools: payload.tools ?? [] })) / 3) +
      12 * (payload.messages.length + (payload.tools?.length ?? 0) + 1);
    assert.ok(wireInputTokens <= Math.floor(18000 * 0.86));
    const quoteMessage = payload.messages.find((message) => typeof message.content === "string" && message.content.startsWith("长期记忆原文引用"));
    const quotes = quoteMessage ? JSON.parse(String(quoteMessage.content).split("\n").slice(1).join("\n")) as Array<{ nodeId: string; role: string; text: string; offset: number; end: number }> : [];
    for (const quote of quotes) {
      const source = evaluationCorpus.find((item) => item.id === quote.nodeId)!;
      const original = quote.role === "user" ? source.text : source.assistant!;
      assert.equal(quote.text, Array.from(original).slice(quote.offset, quote.end).join(""));
    }
    assert.ok(Number(presented.tokens) <= budget);
    assert.ok(events.filter((event) => event.type === "context_projected").every((event) => Number(event.estimatedTokens) <= Number(event.budget)));
    assert.ok(!shown.has("old-place"));
    assert.doesNotMatch(JSON.stringify(fixture.seen.at(-1)!.messages), /old_hidden/);
    if (scenario.akashaQuote && mode === "akasha") assert.ok(JSON.stringify(fixture.seen.at(-1)!.messages).includes(scenario.akashaQuote));
    if (scenario.quote) assert.ok(JSON.stringify(fixture.seen.at(-1)!.messages).includes(scenario.quote));
    if (mode === "dense") assert.ok(!events.some((event) => event.type === "memory_learned" && !evaluationCorpus.some((item) => item.id === event.requestId)));
    else assert.ok(events.filter((event) => event.type === "memory_learned" && !evaluationCorpus.some((item) => item.id === event.requestId)).every((event) =>
      (event.activated as Array<{ nodeId: string }>).every((item) => top8.includes(item.nodeId) && shown.has(item.nodeId))));
    if (scenario.inspectExcluded) {
      const modelCalls = fixture.seen.length;
      await fixture.send(`/memory log ${scenario.inspectExcluded}`);
      assert.match(fixture.sent.at(-1)!, /old_hidden/);
      assert.equal(fixture.seen.length, modelCalls);
      assert.equal((await fixture.rootLog.read()).filter((event) => event.type === "memory_learned").length, events.filter((event) => event.type === "memory_learned").length);
    }
    t.diagnostic(JSON.stringify({ scenario: scenario.name, mode, covered, required: scenario.required.length, top8Covered: scenario.required.filter((nodeId) => top8.includes(nodeId)).length,
      background, errors, shown: [...shown], tokens: presented.tokens, budget, elapsedMs: Math.round(elapsedMs), queryEmbeddingRequests: embeddingRequests - queryRequests,
      totalEmbeddingRequests: embeddingRequests - requestsBefore, setupMs: Math.round(queryStarted - started), wireInputTokens }));
  }
});

test("ordinary file tools cannot overwrite memory, embedding or historical initialization stores", async (t) => {
  let path = "";
  const fixture = await memoryFixture(t, (data, res) => {
    if (data.messages.at(-1)!.role === "tool") answer(res, "已检查工具结果");
    else answer(res, "", { name: "write", args: { path, content: "overwrite-memory-attack" } });
  });
  await fixture.rootLog.append({ type: "message", role: "user", chatId: 42, requestId: "protected-memory", text: "limboo 原始原话" });
  for (const name of ["memory.sqlite", "EMBEDDINGS.SQLITE", "memory-initialization/memory.sqlite"]) {
    path = join(fixture.dir, name); await fixture.send("尝试普通写入");
    const result = (await fixture.rootLog.read()).findLast((event) => event.type === "tool_result")!.result as ToolResult;
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /受保护/);
  }
  assert.ok((await fixture.rootLog.read()).some((event) => event.type === "message" && event.requestId === "protected-memory" && event.text === "limboo 原始原话"));
});

test("invalid memory budgets and algorithm settings fail configuration before a model call", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "memory-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test" };
  await assert.rejects(createPiAgent({ ...options, memoryBudget: { maxTokens: 4097 } }), /预算无效/);
  await assert.rejects(createPiAgent({ ...options, memoryDynamics: { strengthMs: 0 } }), /动力学配置无效/);
  await assert.rejects(createPiAgent({ ...options, memoryRecall: { iterations: 100 } }), /召回配置无效/);
});
