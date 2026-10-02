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
function answer(res: ServerResponse, text: string, tool?: { name: string; args: unknown }, kind = "final") {
  const delta = tool ? { tool_calls: [{ index: 0, id: `memory-call-${++toolSequence}`, type: "function",
    function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } :
    { content: JSON.stringify({ type: kind, text }) };
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
  const options = { dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false, ...extra };
  let agent = await createPiAgent(options);
  const sent: string[] = [];
  const makeApp = (overrides: Partial<Parameters<typeof createApp>[0]> = {}) => createApp({ ownerId: 42, dataDir: dir, log, answer: agent.answer, memoryVector: agent.memoryVector, send: async (text) => { sent.push(text); }, ...overrides });
  let app = makeApp(); let id = 0;
  t.after(async () => { await agent.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  return { dir, log, seen, sent, makeApp,
    initializeMemory: () => agent.initializeMemory(log, 42),
    recover: () => app.recover(),
    send: (text: string) => app.handle({ userId: 42, chatType: "private", text, messageId: ++id }),
    async restart(clearCaches: string[] = []) { await agent.close(); for (const name of clearCaches) await rm(join(dir, name), { force: true }); agent = await createPiAgent(options); app = makeApp(); },
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

test("delivery reinforces only the automatic top eight actually shown and recovery never repeats it", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), { memoryBudget: { maxTokens: 1500 } });
  for (let index = 0; index < 12; index++) await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: `activation-${index}`, text: `limboo 战士${index}` });
  await fixture.send("/reset"); await fixture.send("limboo");
  const events = await fixture.log.read();
  const snapshot = events.findLast((event) => event.type === "memory_recalled")!;
  const shown = events.findLast((event) => event.type === "memory_presented")!.shown as Array<{ nodeId: string }>;
  assert.ok(shown.length > 8);
  const learning = events.filter((event) => event.type === "memory_learned" && event.requestId === snapshot.requestId);
  assert.equal(learning.length, 1);
  const expected = (snapshot.candidates as Array<{ nodeId: string }>).slice(0, 8).map((candidate) => candidate.nodeId);
  assert.deepEqual((learning[0]!.activated as Array<{ nodeId: string }>).map((candidate) => candidate.nodeId), expected);
  await fixture.restart(); await fixture.recover(); await fixture.recover();
  assert.equal((await fixture.log.read()).filter((event) => event.type === "memory_learned" && event.requestId === snapshot.requestId).length, 1);
});

test("unshown top-eight candidates are skipped without substituting the ninth", async (t) => {
  const fixture = await memoryFixture(t, (data, res) => {
    if (data.messages.at(-1)!.role === "tool") answer(res, "答复");
    else answer(res, "", { name: "memory_search", args: { query: "private_ninth", limit: 1 } });
  }, { memoryBudget: { maxTokens: 350 } });
  for (let index = 0; index < 9; index++) await fixture.log.append({ type: "message", role: "user", chatId: 42,
    requestId: `unshown-${index === 8 ? 9 : index}`, text: index === 8 ? "limboo private_ninth" : `limboo rare_private ${index}` });
  await fixture.send("/reset"); await fixture.send("limboo rare_private");
  const events = await fixture.log.read();
  assert.equal((events.findLast((event) => event.type === "memory_recalled")!.candidates as Array<{ nodeId: string }>)[8]!.nodeId, "unshown-9");
  const activated = events.findLast((event) => event.type === "memory_learned")!.activated as Array<{ nodeId: string }>;
  assert.ok(activated.length > 0 && activated.length < 8);
  assert.ok(!activated.some((item) => item.nodeId === "unshown-9"));
  assert.ok(events.some((event) => event.type === "memory_presented" && (event.shown as Array<{ nodeId: string }>).some((item) => item.nodeId === "unshown-9")));
});

test("failed final delivery does not learn, but a delivered result in a failed request does", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"));
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "old-failure", text: "limboo" });
  const rejected = fixture.makeApp({ send: async (text) => { if (text === "答复") throw new Error("transport failure"); } });
  await rejected.handle({ userId: 42, chatType: "private", text: "limboo", messageId: 100 });
  assert.ok(!(await fixture.log.read()).some((event) => event.type === "memory_learned"));
  let calls = 0;
  const partial = await memoryFixture(t, (_data, res) => {
    if (++calls === 1) answer(res, "已送达的阶段成果", undefined, "result");
    else { res.writeHead(401); res.end(JSON.stringify({ error: { message: "failure" } })); }
  });
  await partial.log.append({ type: "message", role: "user", chatId: 42, requestId: "old-partial", text: "limboo" });
  let telegramId = 0;
  const app = partial.makeApp({ telegram: { send: async () => ++telegramId, edit: async () => {} } });
  await app.handle({ userId: 42, chatType: "private", text: "limboo", messageId: 200 });
  const events = await partial.log.read();
  assert.ok(events.some((event) => event.type === "request_failed"));
  const learning = events.findLast((event) => event.type === "memory_learned")!;
  assert.ok(learning);
  assert.deepEqual((learning.activated as Array<{ nodeId: string }>).map((item) => item.nodeId), ["old-partial"]);
});

test("recovery supplements an interrupted learning commit once, using the recorded snapshot", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"));
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "old-recovery", text: "limboo" });
  const interrupted = fixture.makeApp({ log: { ...fixture.log, append: async (event) => {
    if (event.type === "memory_learned") throw new Error("simulated interruption");
    return fixture.log.append(event);
  } } });
  await interrupted.handle({ userId: 42, chatType: "private", text: "limboo", messageId: 100 });
  assert.ok(!(await fixture.log.read()).some((event) => event.type === "memory_learned"));
  await fixture.log.append({ type: "memory_excluded", nodeId: "old-recovery" });
  await fixture.recover(); await fixture.recover();
  const learning = (await fixture.log.read()).filter((event) => event.type === "memory_learned");
  assert.equal(learning.length, 1);
  assert.deepEqual(learning[0]!.activated, []);
});

test("late delivered messages and vector-cache removal never rewrite learned initialization", async (t) => {
  const indexed = new Set<string>();
  const now = Date.now() + 60_000;
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    input.forEach((text) => indexed.add(text));
    res.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: text.includes("surgery") ? [0, 1] : [1, 0] })) }));
  });
  const fixture = await memoryFixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "tool") answer(res, String(last.content));
    else if (last.content === "查状态") answer(res, "", { name: "memory_search", args: { query: "limboo" } });
    else answer(res, "答复");
  }, { embedding: { baseUrl, model: "frozen", apiKey: "test" }, memoryNow: () => now });
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "frozen", text: "limboo daily" });
  await fixture.send("索引"); await eventually(() => indexed.has("limboo daily"));
  await fixture.send("limboo");
  const initial = (await fixture.log.read()).find((event) => event.type === "memory_initialized" && event.nodeId === "frozen")!;
  assert.equal(initial.salience, 0);
  await fixture.log.append({ type: "text_finalized", requestId: "frozen", textSegmentId: "late-frozen", contentKind: "final", text: "surgery" });
  await fixture.log.append({ type: "delivery_succeeded", requestId: "frozen" });
  await fixture.send("查状态"); await eventually(() => indexed.has("surgery"));
  const inspect = async (messageId: number) => {
    const app = fixture.makeApp({ send: async (text) => { if (text.startsWith("[")) throw new Error("no inspection delivery"); } });
    await app.handle({ userId: 42, chatType: "private", messageId, text: "查状态" });
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
  assert.equal((await fixture.log.read()).filter((event) => event.type === "memory_initialized" && event.nodeId === "frozen").length, 1);
});

test("existing original context qualifies for learning but summary-only history does not", async (t) => {
  const summary = "## Goal\nContinue.\n## Progress\nPast limboo discussion.\n## Constraints\nPreserve evidence.\n## Decisions\nUse sources.\n## Next Steps\nAnswer.\n## Critical Context\nSummary is lossy.";
  const fixture = await memoryFixture(t, (data, res) => {
    if (JSON.stringify(data.messages).includes("HISTORY_COMPACTION")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: summary }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    } else answer(res, "答复");
  }, { contextWindow: 7600, memoryBudget: { maxTokens: 0 } });
  for (let index = 0; index < 5; index++) {
    const requestId = `summary-source-${index}`;
    await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId, text: `limboo original_marker_${index} ` + "x".repeat(2500) });
    await fixture.log.append({ type: "answer_generated", requestId, text: "y".repeat(2500) });
    await fixture.log.append({ type: "delivery_succeeded", requestId });
    await fixture.log.append({ type: "request_completed", requestId });
  }
  await fixture.send("limboo");
  const events = await fixture.log.read();
  const shown = events.findLast((event) => event.type === "memory_presented")!.shown as Array<{ nodeId: string; existing: boolean }>;
  const activated = events.findLast((event) => event.type === "memory_learned")!.activated as Array<{ nodeId: string }>;
  assert.ok(shown.length > 0 && shown.every((item) => item.existing));
  assert.ok(activated.length > 0 && activated.length < 5);
  assert.deepEqual(new Set(activated.map((item) => item.nodeId)), new Set(shown.map((item) => item.nodeId)));
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /历史摘要/);
});

test("learned local associations inject original background without a literal match", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"));
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "game", text: "limboo 是我的朋友" });
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "care", text: "引流条每天换药" });
  await fixture.send("limboo 引流条");
  await fixture.send("/reset"); await fixture.send("limboo 最近怎样");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /引流条每天换药/);
  const candidates = (await fixture.log.read()).findLast((event) => event.type === "memory_recalled")!.candidates as Array<{ nodeId: string; sources: string[] }>;
  assert.ok(candidates.find((item) => item.nodeId === "care")!.sources.includes("local"));
});

test("multiple learned seed paths discover far-field background and excluded nodes cannot bridge", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"));
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "far-care", at: new Date(Date.now() - 3 * 86400_000).toISOString(), text: "引流条每天换药" });
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "far-game", text: "limboo 是我的朋友" });
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "far-family", text: "舍友和我联机" });
  await fixture.send("limboo 舍友 引流条");
  await fixture.send("/reset"); await fixture.send("limboo 舍友 最近怎样");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /引流条每天换药/);
  const snapshot = (await fixture.log.read()).findLast((event) => event.type === "memory_recalled")!;
  const distant = (snapshot.candidates as Array<{ nodeId: string; sources: string[]; paths: string[][] }>).find((item) => item.nodeId === "far-care")!;
  assert.ok(distant.sources.includes("far")); assert.ok(!distant.sources.includes("local"));
  assert.ok(new Set(distant.paths.map((path) => path[0])).size >= 2);
  await fixture.log.append({ type: "memory_excluded", nodeId: "far-care" });
  await fixture.send("/reset"); await fixture.send("limboo 舍友 最近怎样");
  assert.doesNotMatch(JSON.stringify(fixture.seen.at(-1)!.messages), /引流条每天换药/);
});

test("a greeting hub and unrelated noise cannot outrank a direct personal-name fact", async (t) => {
  const fixture = await memoryFixture(t, (data, res) => {
    if (data.messages.at(-1)!.role === "tool") answer(res, String(data.messages.at(-1)!.content));
    else answer(res, "", { name: "memory_search", args: { query: "limboo", limit: 20 } });
  }, { memoryRecall: { maxLocalNodes: 16, iterations: 3, maxTransitions: 4 } });
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "specific", text: "limboo 是我的朋友" });
  await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: "hub", text: "你好 晚安" });
  const dynamics = { strengthMs: 7 * 86400_000, edgeMs: 14 * 86400_000, resourceMs: 30 * 60_000, strengthCap: 3, edgeCap: 2,
    strengthRate: 0.18, resourceRate: 0.35, edgeRate: 0.12, backwardRatio: 0.25 };
  for (let index = 0; index < 24; index++) {
    await fixture.log.append({ type: "message", role: "user", chatId: 42, requestId: `noise-${index}`, text: "不相关背景" });
    await fixture.log.append({ type: "memory_learned", requestId: `noise-${index}`, userId: 42, algorithm: "akasha-v1", origin: "online", settledAt: new Date().toISOString(), dynamics,
      activated: [{ nodeId: "hub", signal: 0.7, score: 2 }, ...(index === 0 ? [{ nodeId: "specific", signal: 0.7, score: 2 }] : [])] });
  }
  await fixture.send("/reset"); await fixture.send("查询名字");
  const results = JSON.parse(fixture.sent.at(-1)!) as Array<{ nodeId: string; score: number; paths: string[][] }>;
  assert.equal(results[0]!.nodeId, "specific");
  assert.ok(results.every((item) => Number.isFinite(item.score) && item.score >= 0));
  assert.ok(results.every((item) => item.paths.length <= 4 && item.paths.every((path) => path.length <= 4)));
});

async function historicalTurn(log: ReturnType<typeof createSqliteRuntimeLog>, requestId: string, text: string, at: number) {
  await log.append({ type: "message", role: "user", chatId: 42, requestId, text, at: new Date(at).toISOString() });
  await log.append({ type: "answer_generated", requestId, text: "历史答复", at: new Date(at + 100).toISOString() });
  await log.append({ type: "delivery_succeeded", requestId, at: new Date(at + 200).toISOString() });
  await log.append({ type: "request_completed", requestId, at: new Date(at + 300).toISOString() });
}

test("historical initialization causally learns old associations at original times, without future names", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"));
  const old = Date.now() - 3 * 86400_000;
  await historicalTurn(fixture.log, "history-game", "limboo 是我的朋友", old);
  await historicalTurn(fixture.log, "history-care", "引流条每天换药", old + 60_000);
  await historicalTurn(fixture.log, "history-link", "limboo 引流条", old + 120_000);
  await historicalTurn(fixture.log, "history-future", "未来专名 zxyz", old + 180_000);
  await fixture.initializeMemory();
  const simulated = (await fixture.log.read()).filter((event) => event.type === "memory_learned" && event.origin === "historical");
  assert.equal(simulated.length, 4);
  assert.ok(simulated.every((event) => Date.parse(String(event.settledAt)) < old + 200_000));
  const link = simulated.find((event) => event.requestId === "history-link")!;
  assert.deepEqual(new Set((link.activated as Array<{ nodeId: string }>).map((item) => item.nodeId)), new Set(["history-game", "history-care"]));
  assert.ok(simulated.filter((event) => event.requestId !== "history-future").every((event) =>
    !(event.candidates as Array<{ nodeId: string }>).some((item) => item.nodeId === "history-future")));
  await fixture.send("/reset"); await fixture.send("limboo");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /引流条每天换药/);
  await fixture.restart(); await fixture.initializeMemory();
  assert.equal((await fixture.log.read()).filter((event) => event.type === "memory_learned" && event.origin === "historical").length, 4);
});

test("a stalled background initialization never blocks new chat and resumes its fixed boundary after restart", async (t) => {
  let available = false;
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    if (!available) { res.writeHead(503); res.end(); }
    else embeddingResponse(res, input, [1, 0]);
  });
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), { embedding: { baseUrl, model: "bootstrap", apiKey: "test", timeoutMs: 30 } });
  const old = Date.now() - 86400_000;
  await historicalTurn(fixture.log, "resume-game", "limboo 是我的朋友", old);
  await historicalTurn(fixture.log, "resume-care", "引流条每天换药", old + 60_000);
  await historicalTurn(fixture.log, "resume-link", "limboo 引流条", old + 120_000);
  const pendingInitialization = fixture.initializeMemory();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const started = performance.now(); await fixture.send("独立的新聊天");
  assert.ok(performance.now() - started < 1000);
  const onlineBefore = (await fixture.log.read()).filter((event) => event.type === "memory_learned" && event.origin === "online");
  assert.equal(onlineBefore.length, 1);
  await fixture.restart(); await pendingInitialization;
  available = true; await fixture.initializeMemory();
  const events = await fixture.log.read();
  assert.equal(events.filter((event) => event.type === "memory_bootstrap_started").length, 1);
  assert.equal(events.filter((event) => event.type === "memory_learned" && event.origin === "online").length, 1);
  const simulated = events.filter((event) => event.type === "memory_learned" && event.origin === "historical");
  assert.equal(simulated.length, 3);
  assert.ok(simulated.every((event) => event.requestId !== onlineBefore[0]!.requestId));
});

test("historical progress resumes after partial simulation and skips excluded and already-online requests", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"));
  const old = Date.now() - 86400_000;
  for (let index = 0; index < 12; index++) await historicalTurn(fixture.log, `partial-${index}`, `limboo 旧经历${index}`, old + index * 60_000);
  await fixture.log.append({ type: "memory_excluded", nodeId: "partial-3" });
  await fixture.log.append({ type: "memory_learned", userId: 42, requestId: "partial-7", algorithm: "akasha-v1", origin: "online", activated: [],
    settledAt: new Date(old + 7 * 60_000 + 300).toISOString() });
  const running = fixture.initializeMemory();
  for (let tick = 0; tick < 200; tick++) {
    if ((await fixture.log.read()).some((event) => event.type === "memory_bootstrap_progress")) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await fixture.restart(); await running; await fixture.initializeMemory();
  const events = await fixture.log.read();
  const simulated = events.filter((event) => event.type === "memory_learned" && event.origin === "historical");
  assert.equal(simulated.length, 10); assert.equal(new Set(simulated.map((event) => event.requestId)).size, 10);
  assert.ok(simulated.every((event) => event.requestId !== "partial-3" && event.requestId !== "partial-7"));
  assert.ok(simulated.every((event) => !(event.activated as Array<{ nodeId: string }>).some((item) => item.nodeId === "partial-3")));
  assert.equal(events.filter((event) => event.type === "memory_bootstrap_completed").length, 1);
});

test("legacy message-only history initializes stable original turn associations", async (t) => {
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"));
  const old = Date.now() - 86400_000;
  for (const [index, text] of ["limboo 是我的朋友", "引流条每天换药", "limboo 引流条"].entries()) {
    await fixture.log.append({ type: "message", role: "user", text, at: new Date(old + index * 60_000).toISOString() });
    await fixture.log.append({ type: "message", role: "assistant", text: "旧版原话答复", at: new Date(old + index * 60_000 + 100).toISOString() });
  }
  await fixture.initializeMemory();
  assert.equal((await fixture.log.read()).filter((event) => event.type === "memory_learned" && event.origin === "historical").length, 3);
  await fixture.send("/reset"); await fixture.send("limboo");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /引流条每天换药/);
});

test("late historical delivery warms its settlement prefix while retrieval remains causal", async (t) => {
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    res.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: text === "daily" ? [1, 0] : [0, 1] })) }));
  });
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), { embedding: { baseUrl, model: "late-history", apiKey: "test" } });
  const old = Date.now() - 86400_000;
  await fixture.log.append({ type: "message", role: "user", requestId: "late-a", chatId: 42, text: "daily", at: new Date(old).toISOString() });
  await fixture.log.append({ type: "text_finalized", requestId: "late-a", textSegmentId: "late-a-final", contentKind: "final", text: "surgery", at: new Date(old + 100).toISOString() });
  await historicalTurn(fixture.log, "early-b", "different", old + 1000);
  await fixture.log.append({ type: "delivery_succeeded", requestId: "late-a", at: new Date(old + 2000).toISOString() });
  await fixture.log.append({ type: "request_completed", requestId: "late-a", at: new Date(old + 2100).toISOString() });
  await fixture.initializeMemory();
  const events = await fixture.log.read();
  const initialized = events.find((event) => event.type === "memory_initialized" && event.nodeId === "late-a")!;
  assert.ok(Math.abs(Number(initialized.salience) - 0.2111456180001683) < 1e-12);
  const simulation = events.find((event) => event.type === "memory_learned" && event.requestId === "late-a")!;
  assert.deepEqual(simulation.candidates, []);
  const early = events.find((event) => event.type === "memory_learned" && event.requestId === "early-b")!;
  assert.deepEqual(early.activated, []);
});

test("changed embedding configuration creates a new simulation identity without replaying committed learning twice", async (t) => {
  const baseUrl = await embeddingService(t, (input, _model, res) => embeddingResponse(res, input, [1, 0]));
  const config = { baseUrl, model: "old-history-model", apiKey: "test" };
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), { embedding: config });
  for (let index = 0; index < 12; index++) await historicalTurn(fixture.log, `model-history-${index}`, "limboo", Date.now() - 86400_000 + index * 60_000);
  const running = fixture.initializeMemory();
  for (let tick = 0; tick < 300; tick++) {
    if ((await fixture.log.read()).some((event) => event.type === "memory_bootstrap_progress")) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const partial = (await fixture.log.read()).filter((event) => event.type === "memory_learned");
  assert.ok(partial.length > 0 && partial.length < 12);
  config.model = "new-history-model";
  await fixture.restart(); await running; await fixture.initializeMemory();
  const events = await fixture.log.read();
  const starts = events.filter((event) => event.type === "memory_bootstrap_started");
  assert.equal(starts.length, 2); assert.notEqual(starts[0]!.simulationId, starts[1]!.simulationId);
  assert.equal(starts[0]!.through, starts[1]!.through);
  const learning = events.filter((event) => event.type === "memory_learned");
  assert.equal(learning.length, 12); assert.equal(new Set(learning.map((event) => event.requestId)).size, 12);
  const progress = events.find((event) => event.type === "memory_bootstrap_progress" && event.simulationId === starts[1]!.simulationId)!;
  assert.equal(progress.cursor, 3);
});

test("historical early reinforcement freezes a user-only baseline before a late assistant arrives", async (t) => {
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    res.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: text === "surgery" ? [0, 1] : [1, 0] })) }));
  });
  const fixture = await memoryFixture(t, (_data, res) => answer(res, "答复"), { embedding: { baseUrl, model: "early-frozen", apiKey: "test" } });
  const old = Date.now() - 86400_000;
  await fixture.log.append({ type: "message", role: "user", requestId: "frozen-late-a", chatId: 42, text: "daily", at: new Date(old).toISOString() });
  await fixture.log.append({ type: "text_finalized", requestId: "frozen-late-a", textSegmentId: "frozen-late-a-final", contentKind: "final", text: "surgery", at: new Date(old + 100).toISOString() });
  await historicalTurn(fixture.log, "frozen-early-b", "different", old + 1000);
  await fixture.log.append({ type: "delivery_succeeded", requestId: "frozen-late-a", at: new Date(old + 2000).toISOString() });
  await fixture.log.append({ type: "request_completed", requestId: "frozen-late-a", at: new Date(old + 2100).toISOString() });
  await fixture.initializeMemory();
  const events = await fixture.log.read();
  const initial = events.find((event) => event.type === "memory_initialized" && event.nodeId === "frozen-late-a")!;
  assert.equal(initial.salience, 0);
  assert.deepEqual((events.find((event) => event.type === "memory_learned" && event.requestId === "frozen-early-b")!.activated as Array<{ nodeId: string }>).map((item) => item.nodeId), ["frozen-late-a"]);
  assert.equal(events.filter((event) => event.type === "memory_initialized" && event.nodeId === "frozen-late-a").length, 1);
});
