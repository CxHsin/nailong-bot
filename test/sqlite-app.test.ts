import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/application/app.js";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";

test("private Telegram requests use one SQLite source across restart and reset", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-app-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  await log.importLegacy();
  const seen: string[][] = [];
  const sent: string[] = [];
  const makeApp = () => createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (messages) => {
      seen.push(messages.map((message) => message.text));
      return `答复 ${seen.length}`;
    },
    send: async (text) => { sent.push(text); },
  });
  const first = makeApp();
  await first.handle({ userId: 99, chatType: "private", text: "foreign", messageId: 1 });
  await first.handle({ userId: 42, chatType: "group", text: "group", messageId: 2 });
  assert.deepEqual(await log.read(), []);
  await first.handle({ userId: 42, chatType: "private", text: "first", messageId: 3 });
  await makeApp().handle({ userId: 42, chatType: "private", text: "second", messageId: 4 });
  assert.deepEqual(seen, [["first"], ["first", "答复 1", "second"]]);
  await makeApp().handle({ userId: 42, chatType: "private", text: "/reset", messageId: 5 });
  await makeApp().handle({ userId: 42, chatType: "private", text: "third", messageId: 6 });
  assert.deepEqual(seen[2], ["third"]);
  assert.equal(sent.at(-1), "答复 3");
  const events = await log.read();
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  await assert.rejects(readFile(join(dir, "events.jsonl"), "utf8"), { code: "ENOENT" });
});


test("SQLite commits Pi tool facts before the next model step", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-pi-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  await log.importLegacy();
  const observed: string[][] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    observed.push((await log.read()).map((event) => event.type));
    const first = observed.length === 1;
    const delta = first ? { tool_calls: [{ index: 0, id: "read-one", type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: "system-prompt.md" }) } }] } : { content: JSON.stringify({ type: "final", text: "已查看目录" }) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta,
      finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => agent.close());
  const replies: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log, answer: agent.answer,
    send: async (text) => { replies.push(text); } });
  await app.handle({ userId: 42, chatType: "private", text: "查看目录", messageId: 1 });
  assert.equal(replies.at(-1), "已查看目录");
  assert.equal(observed.length, 2);
  assert.ok(observed[0]?.includes("model_step_started"));
  for (const kind of ["model_message", "tool_call", "tool_dispatch", "tool_result", "model_step_completed"]) {
    assert.ok(observed[1]?.includes(kind), `${kind} must be durable before the next provider call`);
  }
  await assert.rejects(readFile(join(dir, "events.jsonl"), "utf8"), { code: "ENOENT" });
});

test("private Telegram sees committed progress before tool work and final text in place", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-stream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  await log.importLegacy();
  let calls = 0;
  const contexts: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    contexts.push(JSON.parse(body).messages);
    calls++;
    const delta = calls === 1 ? { content: JSON.stringify({ type: "progress", text: "我先查看目录。" }), tool_calls: [{ index: 0, id: "ls-one", type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: "system-prompt.md" }) } }] } : { content: JSON.stringify({ type: "final", text: "目录已查看。" }) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta,
      finish_reason: calls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => agent.close());
  const messages = new Map<number, string>();
  const sentAt: string[][] = [];
  let nextId = 0;
  const app = createApp({ ownerId: 42, dataDir: dir, log, answer: agent.answer,
    send: async () => { throw new Error("final answer must not be sent twice"); },
    telegram: {
      send: async (text) => { sentAt.push((await log.read()).map((event) => event.type));
        messages.set(++nextId, text); return nextId; },
      edit: async (id, text) => { messages.set(id, text); },
    },
  });
  await app.handle({ userId: 42, chatType: "private", text: "查看目录", messageId: 1 });
  assert.equal(calls, 2);
  assert.deepEqual([...messages.values()], ["我先查看目录。", "目录已查看。"]);
  assert.ok(sentAt[0]?.includes("text_snapshot"));
  assert.ok(!sentAt[0]?.includes("tool_dispatch"));
  const events = await log.read();
  assert.equal(events.filter((event) => event.type === "text_finalized" && event.contentKind === "progress").length, 1);
  assert.equal(events.filter((event) => event.type === "text_finalized" && event.contentKind === "final").length, 1);
  assert.equal(events.filter((event) => event.type === "delivery_succeeded").length, 1);
  await app.handle({ userId: 42, chatType: "private", text: "继续", messageId: 2 });
  assert.match(JSON.stringify(contexts[2]), /我先查看目录/);
  assert.match(JSON.stringify(contexts[2]), /目录已查看/);
});

test("committed progress remains in context when tool dispatch fails", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-progress-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  await log.importLegacy();
  const contexts: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    contexts.push(JSON.parse(body).messages);
    const first = contexts.length === 1;
    const delta = first ? { content: JSON.stringify({ type: "progress", text: "我先检查目录。" }), tool_calls: [{ index: 0, id: "ls-one",
      type: "function", function: { name: "read", arguments: JSON.stringify({ path: "system-prompt.md" }) } }] }
      : { content: JSON.stringify({ type: "final", text: "继续处理" }) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta,
      finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => agent.close());
  let fail = true;
  const faulty = { ...log, append: async (event: Parameters<typeof log.append>[0]) => {
    if (event.type === "tool_dispatch" && fail) { fail = false; throw new Error("commit failure"); }
    return log.append(event);
  } };
  const app = createApp({ ownerId: 42, dataDir: dir, log: faulty,
    answer: agent.answer, send: async () => {} });
  await app.handle({ userId: 42, chatType: "private", text: "检查", messageId: 1 });
  await app.handle({ userId: 42, chatType: "private", text: "继续", messageId: 2 });
  const context = JSON.stringify(contexts[1]);
  assert.match(context, /我先检查目录/);
  assert.equal(context.split("我先检查目录").length - 1, 1);
});

test("restart interrupts open work and reconciles only safe Telegram segments", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-recover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  await log.append({ type: "request_started", requestId: "old" });
  await log.append({ type: "text_snapshot", requestId: "old", textSegmentId: "unsent",
    contentKind: "provisional", text: "未尝试" });
  await log.append({ type: "text_snapshot", requestId: "old", textSegmentId: "unknown",
    contentKind: "provisional", text: "结果未知" });
  await log.append({ type: "telegram_delivery_attempt", requestId: "old", textSegmentId: "unknown",
    partIndex: 0, attemptId: "attempt-1", snapshotEventId: "snapshot-unknown", action: "send", chatId: 42 });
  const sent: string[] = [];
  const makeApp = () => createApp({ ownerId: 42, dataDir: dir, log,
    answer: async () => { throw new Error("agent must not resume"); },
    send: async () => {},
    telegram: { send: async (text) => { sent.push(text); return sent.length; }, edit: async () => {} },
  });
  await makeApp().recover();
  await makeApp().recover();
  assert.deepEqual(sent, ["未尝试"]);
  const events = await log.read();
  assert.equal(events.filter((event) => event.type === "request_interrupted" && event.requestId === "old").length, 1);
  assert.equal(events.filter((event) => event.type === "telegram_delivery_attempt" &&
    event.textSegmentId === "unknown").length, 1);
});

test("restart acknowledges a final answer only after all committed text is delivered", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-final-recover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  await log.append({ type: "request_started", requestId: "old" });
  await log.append({ type: "text_snapshot", requestId: "old", textSegmentId: "final",
    contentKind: "provisional", text: "已完成" });
  await log.append({ type: "text_finalized", requestId: "old", textSegmentId: "final",
    contentKind: "final", text: "已完成" });
  const sent: string[] = [];
  const makeApp = () => createApp({ ownerId: 42, dataDir: dir, log,
    answer: async () => { throw new Error("agent must not resume"); }, send: async () => {},
    telegram: { send: async (text) => { sent.push(text); return 77; }, edit: async () => {} },
  });
  await makeApp().recover();
  await makeApp().recover();
  assert.deepEqual(sent, ["已完成"]);
  const events = await log.read();
  assert.equal(events.filter((event) => event.type === "delivery_succeeded" && event.requestId === "old").length, 1);
  assert.equal(events.filter((event) => event.type === "answer_generated" && event.requestId === "old").length, 1);
});

test("partially delivered final answer stays out of the next request", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-partial-final-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const answer = "x".repeat(5000);
  let answerCalls = 0;
  let sends = 0;
  let nextMessages: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (messages, request) => {
      answerCalls++;
      if (answerCalls > 1) { nextMessages = messages.map((message) => message.text); return "继续处理"; }
      await request.log.append({ type: "text_snapshot", requestId: request.id,
        textSegmentId: "long-final", contentKind: "provisional", text: answer });
      await request.onText?.("long-final");
      await request.log.append({ type: "text_finalized", requestId: request.id,
        textSegmentId: "long-final", contentKind: "final", text: answer });
      await request.onText?.("long-final");
      return answer;
    },
    send: async () => {},
    telegram: { send: async () => { if (++sends === 2) throw new Error("timeout"); return sends; },
      edit: async () => {} },
  });
  await app.handle({ userId: 42, chatType: "private", text: "first", messageId: 1 });
  assert.equal(sends, 2);
  assert.equal((await log.read()).some((event) => event.type === "delivery_succeeded"), false);
  await app.handle({ userId: 42, chatType: "private", text: "second", messageId: 2 });
  assert.deepEqual(nextMessages, ["first", "second"]);
});

for (const fault of ["model_step_started", "text_snapshot", "tool_dispatch"] as const) {
  test(`SQLite ${fault} failure stops unrecorded model or tool work`, { timeout: 60_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), `sqlite-${fault}-`));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const target = join(dir, "unwritten.txt");
    const log = createSqliteRuntimeLog(dir);
    await log.importLegacy();
    let modelCalls = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* Consume provider request. */ }
      modelCalls++;
      const delta = { content: JSON.stringify({ type: "progress", text: "我先写入文件。" }), tool_calls: [{ index: 0, id: "write-one", type: "function",
        function: { name: "write", arguments: JSON.stringify({ path: target, content: "unsafe" }) } }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta,
        finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
      modelBaseUrl: `http://127.0.0.1:${address.port}` });
    t.after(() => agent.close());
    const faulty = { ...log, append: async (event: Parameters<typeof log.append>[0]) => {
      if (event.type === fault) throw new Error("injected SQLite commit failure");
      return log.append(event);
    } };
    const replies: string[] = [];
    const app = createApp({ ownerId: 42, dataDir: dir, log: faulty, answer: agent.answer,
      send: async (text) => { replies.push(text); } });
    await app.handle({ userId: 42, chatType: "private", text: "写文件", messageId: 1 });
    assert.equal(modelCalls, fault === "model_step_started" ? 0 : 1);
    await assert.rejects(access(target), { code: "ENOENT" });
    assert.match(replies.at(-1) ?? "", /暂时处理失败/);
    assert.equal((await log.read()).some((event) => event.type === fault), false);
  });
}
