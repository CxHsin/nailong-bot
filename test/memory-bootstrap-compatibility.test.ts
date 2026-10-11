import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeLog } from "../src/runtime/runtime-types.js";
import { createTelegramHostFixture, type TelegramHostFixtureOptions } from "./fixtures/telegram-host.js";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";
import { createMemoryProjection } from "../src/memory/projection.js";
import { commitMemoryLearning } from "../src/application/memory-learning.js";
import { closeFixture } from "./fixtures/cleanup.js";
import { createTestServer } from "./fixtures/http-server.js";

/** Raw historical simulation remains distinct from current Conversation startup. */
async function historicalFixture(t: TestContext, extra: Partial<TelegramHostFixtureOptions["agentOptions"]> = {},
  channelOptions: Omit<TelegramHostFixtureOptions, "agentOptions"> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "memory-bootstrap-compatibility-"));
  const seen: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    seen.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "答复" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let shutdown = async () => {};
  t.after(() => closeFixture({ server, dir, shutdown: () => shutdown() }));
  const f = await createTelegramHostFixture(t, { agentOptions: { dataDir: dir, promptFile: "system-prompt.md", memoryBootstrap: false,
    deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, ...extra }, ...channelOptions });
  shutdown = () => f.close();
  return { dir, seen, sent: f.sent, get rootLog() { return f.rootLog; },
    initializeMemory: () => f.agent.initializeMemory(f.rootLog, 42),
    searchRaw: (query: string) => createMemoryProjection({ log: f.rootLog, dataDir: dir, userId: 42 }).search(query, 20, "raw-inspection"),
    send: f.send,
    async restart() { await f.restart(); },
  };
}

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

async function historicalTurn(log: RuntimeLog, requestId: string, text: string, at: number) {
  await log.append({ type: "message", role: "user", chatId: 42, requestId, text, at: new Date(at).toISOString() });
  await log.append({ type: "answer_generated", requestId, text: "历史答复", at: new Date(at + 100).toISOString() });
  await log.append({ type: "delivery_succeeded", requestId, at: new Date(at + 200).toISOString() });
  await log.append({ type: "request_completed", requestId, at: new Date(at + 300).toISOString() });
}

test("historical initialization causally learns old associations at original times, without future names", async (t) => {
  const fixture = await historicalFixture(t);
  const old = Date.now() - 3 * 86400_000;
  await historicalTurn(fixture.rootLog, "history-game", "limboo 是我的朋友", old);
  await historicalTurn(fixture.rootLog, "history-care", "引流条每天换药", old + 60_000);
  await historicalTurn(fixture.rootLog, "history-link", "limboo 引流条", old + 120_000);
  await historicalTurn(fixture.rootLog, "history-future", "未来专名 zxyz", old + 180_000);
  await fixture.initializeMemory();
  const simulated = (await fixture.rootLog.read()).filter((event) => event.type === "memory_learned" && event.origin === "historical");
  assert.equal(simulated.length, 4);
  assert.ok(simulated.every((event) => Date.parse(String(event.settledAt)) < old + 200_000));
  const link = simulated.find((event) => event.requestId === "history-link")!;
  assert.deepEqual(new Set((link.activated as Array<{ nodeId: string }>).map((item) => item.nodeId)), new Set(["history-game", "history-care"]));
  assert.ok(simulated.filter((event) => event.requestId !== "history-future").every((event) =>
    !(event.candidates as Array<{ nodeId: string }>).some((item) => item.nodeId === "history-future")));
  await fixture.send("/reset"); await fixture.send("limboo");
  assert.match(JSON.stringify(fixture.seen.at(-1)!.messages), /引流条每天换药/);
  await fixture.restart(); await fixture.initializeMemory();
  assert.equal((await fixture.rootLog.read()).filter((event) => event.type === "memory_learned" && event.origin === "historical").length, 4);
});


test("a stalled background initialization never blocks new chat and resumes its fixed boundary after restart", async (t) => {
  let available = false;
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    if (!available) { res.writeHead(503); res.end(); }
    else embeddingResponse(res, input, [1, 0]);
  });
  const fixture = await historicalFixture(t, { embedding: { baseUrl, model: "bootstrap", apiKey: "test", timeoutMs: 30 } });
  const old = Date.now() - 86400_000;
  await historicalTurn(fixture.rootLog, "resume-game", "limboo 是我的朋友", old);
  await historicalTurn(fixture.rootLog, "resume-care", "引流条每天换药", old + 60_000);
  await historicalTurn(fixture.rootLog, "resume-link", "limboo 引流条", old + 120_000);
  const pendingInitialization = fixture.initializeMemory();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const started = performance.now(); await fixture.send("独立的新聊天");
  assert.ok(performance.now() - started < 1000);
  const onlineBefore = (await fixture.rootLog.read()).filter((event) => event.type === "memory_learned" && event.origin === "online");
  assert.equal(onlineBefore.length, 1);
  await fixture.restart(); await pendingInitialization;
  available = true; await fixture.initializeMemory();
  const events = await fixture.rootLog.read();
  assert.equal(events.filter((event) => event.type === "memory_bootstrap_started").length, 1);
  assert.equal(events.filter((event) => event.type === "memory_learned" && event.origin === "online").length, 1);
  const simulated = events.filter((event) => event.type === "memory_learned" && event.origin === "historical");
  assert.equal(simulated.length, 3);
  assert.ok(simulated.every((event) => event.requestId !== onlineBefore[0]!.requestId));
});


test("historical progress resumes after partial simulation and skips excluded and already-online requests", async (t) => {
  const fixture = await historicalFixture(t);
  const old = Date.now() - 86400_000;
  for (let index = 0; index < 12; index++) await historicalTurn(fixture.rootLog, `partial-${index}`, `limboo 旧经历${index}`, old + index * 60_000);
  await fixture.rootLog.append({ type: "memory_excluded", nodeId: "partial-3" });
  await fixture.rootLog.append({ type: "memory_learned", userId: 42, requestId: "partial-7", algorithm: "akasha-v1", origin: "online", activated: [],
    settledAt: new Date(old + 7 * 60_000 + 300).toISOString() });
  const running = fixture.initializeMemory();
  for (let tick = 0; tick < 200; tick++) {
    if ((await fixture.rootLog.read()).some((event) => event.type === "memory_bootstrap_progress")) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await fixture.restart(); await running; await fixture.initializeMemory();
  const events = await fixture.rootLog.read();
  const simulated = events.filter((event) => event.type === "memory_learned" && event.origin === "historical");
  assert.equal(simulated.length, 10); assert.equal(new Set(simulated.map((event) => event.requestId)).size, 10);
  assert.ok(simulated.every((event) => event.requestId !== "partial-3" && event.requestId !== "partial-7"));
  assert.ok(simulated.every((event) => !(event.activated as Array<{ nodeId: string }>).some((item) => item.nodeId === "partial-3")));
  assert.equal(events.filter((event) => event.type === "memory_bootstrap_completed").length, 1);
});


test("legacy message-only history initializes stable original turn associations", async (t) => {
  const fixture = await historicalFixture(t);
  const old = Date.now() - 86400_000;
  for (const [index, text] of ["limboo 是我的朋友", "引流条每天换药", "limboo 引流条"].entries()) {
    await fixture.rootLog.append({ type: "message", role: "user", text, at: new Date(old + index * 60_000).toISOString() });
    await fixture.rootLog.append({ type: "message", role: "assistant", text: "旧版原话答复", at: new Date(old + index * 60_000 + 100).toISOString() });
  }
  await fixture.initializeMemory();
  assert.equal((await fixture.rootLog.read()).filter((event) => event.type === "memory_learned" && event.origin === "historical").length, 3);
  assert.match(JSON.stringify(await fixture.searchRaw("limboo")), /引流条每天换药/);
});


test("late historical delivery warms its settlement prefix while retrieval remains causal", async (t) => {
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    res.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: text === "daily" ? [1, 0] : [0, 1] })) }));
  });
  const fixture = await historicalFixture(t, { embedding: { baseUrl, model: "late-history", apiKey: "test" } });
  const old = Date.now() - 86400_000;
  await fixture.rootLog.append({ type: "message", role: "user", requestId: "late-a", chatId: 42, text: "daily", at: new Date(old).toISOString() });
  await fixture.rootLog.append({ type: "text_finalized", requestId: "late-a", textSegmentId: "late-a-final", contentKind: "final", text: "surgery", at: new Date(old + 100).toISOString() });
  await historicalTurn(fixture.rootLog, "early-b", "different", old + 1000);
  await fixture.rootLog.append({ type: "delivery_succeeded", requestId: "late-a", at: new Date(old + 2000).toISOString() });
  await fixture.rootLog.append({ type: "request_completed", requestId: "late-a", at: new Date(old + 2100).toISOString() });
  await fixture.initializeMemory();
  const events = await fixture.rootLog.read();
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
  const fixture = await historicalFixture(t, { embedding: config });
  for (let index = 0; index < 12; index++) await historicalTurn(fixture.rootLog, `model-history-${index}`, "limboo", Date.now() - 86400_000 + index * 60_000);
  const running = fixture.initializeMemory();
  for (let tick = 0; tick < 300; tick++) {
    if ((await fixture.rootLog.read()).some((event) => event.type === "memory_bootstrap_progress")) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const partial = (await fixture.rootLog.read()).filter((event) => event.type === "memory_learned");
  assert.ok(partial.length > 0 && partial.length < 12);
  config.model = "new-history-model";
  await fixture.restart(); await running; await fixture.initializeMemory();
  const events = await fixture.rootLog.read();
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
  const fixture = await historicalFixture(t, { embedding: { baseUrl, model: "early-frozen", apiKey: "test" } });
  const old = Date.now() - 86400_000;
  await fixture.rootLog.append({ type: "message", role: "user", requestId: "frozen-late-a", chatId: 42, text: "daily", at: new Date(old).toISOString() });
  await fixture.rootLog.append({ type: "text_finalized", requestId: "frozen-late-a", textSegmentId: "frozen-late-a-final", contentKind: "final", text: "surgery", at: new Date(old + 100).toISOString() });
  await historicalTurn(fixture.rootLog, "frozen-early-b", "different", old + 1000);
  await fixture.rootLog.append({ type: "delivery_succeeded", requestId: "frozen-late-a", at: new Date(old + 2000).toISOString() });
  await fixture.rootLog.append({ type: "request_completed", requestId: "frozen-late-a", at: new Date(old + 2100).toISOString() });
  await fixture.initializeMemory();
  const events = await fixture.rootLog.read();
  const initial = events.find((event) => event.type === "memory_initialized" && event.nodeId === "frozen-late-a")!;
  assert.equal(initial.salience, 0);
  assert.deepEqual((events.find((event) => event.type === "memory_learned" && event.requestId === "frozen-early-b")!.activated as Array<{ nodeId: string }>).map((item) => item.nodeId), ["frozen-late-a"]);
  assert.equal(events.filter((event) => event.type === "memory_initialized" && event.nodeId === "frozen-late-a").length, 1);
});


test("a changed embedding dimension gets a separate historical progress baseline without repeating committed learning", async (t) => {
  let dimension = 2;
  const baseUrl = await embeddingService(t, (input, _model, res) => embeddingResponse(res, input, dimension === 2 ? [1, 0] : [1, 0, 0]));
  const fixture = await historicalFixture(t, { embedding: { baseUrl, model: "dimensions-history", apiKey: "test" } });
  for (let index = 0; index < 12; index++) await historicalTurn(fixture.rootLog, `dimension-history-${index}`, "limboo", Date.now() - 86400_000 + index * 60_000);
  const running = fixture.initializeMemory();
  await eventually(async () => (await fixture.rootLog.read()).some((event) => event.type === "memory_bootstrap_progress"));
  await fixture.restart(); await running;
  dimension = 3;
  await fixture.send("更换维度后的新查询");
  await fixture.initializeMemory();
  const events = await fixture.rootLog.read();
  const starts = events.filter((event) => event.type === "memory_bootstrap_started");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0]!.simulationId, starts[1]!.simulationId);
  assert.equal(starts[0]!.through, starts[1]!.through);
  const learning = events.filter((event) => event.type === "memory_learned");
  assert.equal(new Set(learning.map((event) => event.requestId)).size, learning.length);
  assert.equal(learning.filter((event) => event.origin === "historical").length, 12);
});


test("raw backfill and explicit late-delivery learning retry preserve exclusions across reopen without future leakage", async (t) => {
  let available = false;
  const baseUrl = await embeddingService(t, (input, _model, res) => {
    if (!available) { res.writeHead(503); res.end(); } else embeddingResponse(res, input, [1, 0]);
  });
  let refuseDelivery = true;
  const fixture = await historicalFixture(t, { embedding: { baseUrl, model: "coexist", apiKey: "test", timeoutMs: 100 } }, {
    createTransport: (api) => createTelegramRichTransport({ ...api, sendRich: async (chatId, text, signal) => {
      if (refuseDelivery && text === "答复") throw new Error("late confirmation");
      return api.sendRich(chatId, text, signal);
    } }),
  });
  const old = Date.now() - 86400_000;
  for (let index = 0; index < 5; index++) await historicalTurn(fixture.rootLog, `coexist-${index}`, "limboo 旧事实", old + index * 60_000);
  await fixture.send("limboo 迟到送达轮次", { messageId: 701 });
  refuseDelivery = false;
  const late = (await fixture.rootLog.read()).findLast((event) => event.type === "text_finalized" && event.contentKind === "final")!;
  const running = fixture.initializeMemory();
  await eventually(async () => (await fixture.rootLog.read()).some((event) => event.type === "memory_bootstrap_started"));
  await fixture.send("/forget coexist-1");
  await fixture.send("未来专名 future_zxyz");
  await fixture.restart(); await running;
  available = true;
  const pages = (await fixture.rootLog.read()).filter((event) => event.type === "telegram_page" && event.textSegmentId === late.textSegmentId);
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const attempt = (await fixture.rootLog.read()).findLast((event) => event.type === "telegram_delivery_attempt" &&
      event.textSegmentId === page.textSegmentId && event.partIndex === page.partIndex)!;
    await fixture.rootLog.append({ type: "telegram_delivery_succeeded", requestId: late.requestId, textSegmentId: late.textSegmentId,
      partIndex: page.partIndex, target: page.target, attemptId: attempt.attemptId, telegramMessageId: 800 + Number(page.partIndex) });
  }
  await fixture.rootLog.append({ type: "delivery_succeeded", requestId: late.requestId });
  await fixture.rootLog.append({ type: "request_completed", requestId: late.requestId });
  await commitMemoryLearning(fixture.rootLog, 42);
  await fixture.initializeMemory();
  await commitMemoryLearning(fixture.rootLog, 42);
  const learning = (await fixture.rootLog.read()).filter((event) => event.type === "memory_learned");
  assert.equal(learning.filter((event) => event.requestId === late.requestId && event.origin === "online").length, 1);
  assert.equal(learning.filter((event) => event.origin === "historical").length, 4);
  assert.equal(new Set(learning.map((event) => event.requestId)).size, learning.length);
  assert.ok(learning.every((event) => event.requestId !== "coexist-1" && !(event.activated as Array<{ nodeId: string }>).some((item) => item.nodeId === "coexist-1")));
  assert.ok(learning.filter((event) => event.origin === "historical").every((event) =>
    !(event.candidates as Array<{ nodeId: string }>).some((item) => item.nodeId === late.requestId)));
});
