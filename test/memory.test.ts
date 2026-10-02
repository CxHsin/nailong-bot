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
