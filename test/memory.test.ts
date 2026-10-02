import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/application/app.js";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";

type Payload = { messages: Array<{ role: string; content?: unknown }>; tools?: unknown[] };
let toolSequence = 0;
function answer(res: ServerResponse, text: string, tool?: { name: string; args: unknown }) {
  const delta = tool ? { tool_calls: [{ index: 0, id: `memory-call-${++toolSequence}`, type: "function",
    function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } :
    { content: JSON.stringify({ type: "final", text }) };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}
export async function memoryFixture(t: TestContext, respond: (data: Payload, res: ServerResponse) => void,
  extra: Partial<Parameters<typeof createPiAgent>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nailong-memory-"));
  const seen: Payload[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data: Payload = JSON.parse(body); seen.push(data); respond(data, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const log = createSqliteRuntimeLog(dir);
  const options = { dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, ...extra };
  let agent = await createPiAgent(options);
  const sent: string[] = [];
  const makeApp = () => createApp({ ownerId: 42, dataDir: dir, log, answer: agent.answer, send: async (text) => { sent.push(text); } });
  let app = makeApp(); let id = 0;
  t.after(async () => { await agent.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  return { dir, log, seen, sent,
    send: (text: string) => app.handle({ userId: 42, chatType: "private", text, messageId: ++id }),
    async restart() { await agent.close(); agent = await createPiAgent(options); app = makeApp(); },
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
  assert.ok((await f.log.read()).some((e) => e.type === "tool_dispatch" && e.toolName === "memory_search"));
});

test("memory tools omit unseen assistant text and excluded turns, preserve failed user input", async (t) => {
  const f = await memoryFixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "tool") answer(res, String(last.content));
    else answer(res, "", { name: "memory_search", args: { query: "引流条" } });
  });
  await f.log.append({ type: "message", role: "user", chatId: 42, requestId: "failed", text: "引流条流血", originalText: "引流条流血" });
  await f.log.append({ type: "answer_generated", requestId: "failed", text: "引流条没事（未送达）" });
  await f.log.append({ type: "request_failed", requestId: "failed" });
  await f.log.append({ type: "message", role: "user", chatId: 42, requestId: "excluded", text: "引流条秘密" });
  await f.log.append({ type: "memory_excluded", nodeId: "excluded" });
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
  await f.log.append({ type: "message", role: "user", chatId: 42, requestId: "old", text: "杀戮尖塔：🎮一起玩" });
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
  });
  await f.log.append({ type: "message", role: "user", chatId: 42, requestId: "old-image", text: "旧图片配文", images: [{ mimeType: "image/png", data: "original" }] });
  await f.log.append({ type: "text_finalized", requestId: "old-image", textSegmentId: "old-final", contentKind: "final", protocolVersion: "json-text-v1", text: "旧版已送达正文" });
  await f.log.append({ type: "telegram_delivery_succeeded", requestId: "old-image", textSegmentId: "old-final", partIndex: 0 });
  await f.log.append({ type: "delivery_succeeded", requestId: "old-image" });
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
  const events = await f.log.read();
  const current = events.findLast((e) => e.type === "request_started")!.requestId;
  assert.equal(events.filter((e) => e.type === "memory_recalled" && e.requestId === current).length, 1);
  assert.ok(events.some((e) => e.type === "memory_presented" && e.requestId === current));
});

test("automatic memory quotes obey budgets, exceed eight short nodes and preserve the current question", async (t) => {
  const f = await memoryFixture(t, (_data, res) => answer(res, "答复"), { memoryBudget: { maxTokens: 1000 } });
  for (let index = 0; index < 12; index++) await f.log.append({ type: "message", role: "user", chatId: 42,
    requestId: `old-${index}`, text: `limboo ${index}` });
  await f.log.append({ type: "reset" });
  await f.send("limboo 当前问题");
  const presented = (await f.log.read()).findLast((e) => e.type === "memory_presented")!;
  assert.ok(Number(presented.tokens) <= 1000);
  assert.ok((presented.shown as unknown[]).length > 8);
  assert.equal(f.seen.at(-1)!.messages.at(-1)!.content, "limboo 当前问题");
  await f.log.append({ type: "message", role: "user", chatId: 42, requestId: "huge", text: "limboo " + "🎮".repeat(20_000) });
  await f.log.append({ type: "reset" }); await f.send("limboo 当前问题");
  const bounded = (await f.log.read()).findLast((e) => e.type === "memory_presented")!;
  assert.ok(Number(bounded.tokens) <= 1000);
  assert.ok(JSON.stringify(f.seen.at(-1)!.messages).length < 30_000);
});

test("automatic Chinese excerpts include a match at the end of a long original", async (t) => {
  const f = await memoryFixture(t, (_data, res) => answer(res, "答复"), { memoryBudget: { maxTokens: 350 } });
  await f.log.append({ type: "message", role: "user", chatId: 42, requestId: "long", text: "我和舍友聊了很久" + "无关前言".repeat(3000) + "杀戮尖塔是我们玩的游戏" });
  await f.log.append({ type: "reset" }); await f.send("我和舍友最近还玩杀戮尖塔吗");
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /杀戮尖塔是我们玩的游戏/);
});

test("a rejected provider call never commits a memory presentation", async (t) => {
  const f = await memoryFixture(t, (_data, res) => { res.writeHead(401); res.end(JSON.stringify({ error: { message: "unauthorized" } })); });
  await f.log.append({ type: "message", role: "user", chatId: 42, requestId: "old", text: "limboo 是战士" });
  await f.log.append({ type: "reset" }); await f.send("limboo");
  assert.equal((await f.log.read()).some((e) => e.type === "memory_presented"), false);
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
  await f.log.append({ type: "message", role: "user", chatId: 42, requestId: "sleep", text: "我的睡眠时间是晚上十一点" });
  await f.log.append({ type: "reset" }); await f.send("启动索引");
  for (let tick = 0; tick < 100 && !indexed.has("我的睡眠时间是晚上十一点"); tick++) await new Promise((resolve) => setTimeout(resolve, 10));
  await f.send("有何作息规律");
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /我的睡眠时间是晚上十一点/);
  assert.match(f.sent.at(-1)!, /dense/);
  assert.equal(JSON.parse(f.sent.at(-1)!)[0].similarity, 1);
  const before = requests; await f.send("有何作息规律");
  assert.ok(requests - before < 3);
  assert.doesNotMatch(JSON.stringify(await f.log.read()), /secret/);
});

test("embedding timeout preserves literal recall and records a safe degradation", async (t) => {
  const stalled = createServer((_req, _res) => {});
  await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { stalled.closeAllConnections(); stalled.close(() => resolve()); }));
  const address = stalled.address(); assert.ok(address && typeof address !== "string");
  const f = await memoryFixture(t, (_data, res) => answer(res, "答复"), {
    embedding: { baseUrl: `http://127.0.0.1:${address.port}`, model: "test", apiKey: "private-key", timeoutMs: 30 },
  });
  await f.log.append({ type: "message", role: "user", chatId: 42, requestId: "old", text: "limboo 是战士" });
  await f.log.append({ type: "reset" });
  const started = performance.now(); await f.send("limboo");
  assert.ok(performance.now() - started < 1000);
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /limboo 是战士/);
  const events = await f.log.read(); assert.ok(events.some((e) => e.type === "memory_recalled" && e.degraded === "embedding_unavailable"));
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
async function eventually(predicate: () => boolean) {
  for (let tick = 0; tick < 200 && !predicate(); tick++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate());
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
  for (let index = 0; index < 6; index++) await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: `retry-${index}`, text: `待索引原话${index}` });
  await fixture.send("触发");
  await eventually(() => inputs.some((batch) => batch.length > 1));
  await fixture.log.append({ type: "memory_excluded", nodeId: "retry-3" });
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
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "unicode", text: "🎮".repeat(19) });
  await fixture.log.append({ type: "reset" }); await fixture.send("启动");
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
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "invalid", text: "旧记忆" });
  await fixture.log.append({ type: "reset" }); await fixture.send("旧记忆");
  assert.ok((await fixture.log.read()).some((event) => event.type === "memory_recalled" && event.degraded === "embedding_unavailable"));
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
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "hello", text: "hello" });
  await fixture.send("索引"); await eventually(() => indexed.has("hello"));
  await fixture.send("读一次"); await fixture.send("/reset");
  await fixture.send('{"turn":["hello"]}');
  assert.ok(indexed.has('{"turn":["hello"]}'));
  const snapshot = (await fixture.log.read()).findLast((event) => event.type === "memory_recalled")!;
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
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "slow-long", text: "🪐".repeat(192) });
  await fixture.send("索引"); await eventually(() => completed >= 4);
  await fixture.send("/reset"); await fixture.send("异义");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /🪐/);
});
