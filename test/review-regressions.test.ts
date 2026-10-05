import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createApp } from "../src/application/app.js";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";
import { planTelegramText } from "../src/telegram/telegram-layout.js";

const update = { userId: 42, chatType: "private", text: "处理消息", messageId: 100 };
async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "review-regression-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

for (const storage of ["sqlite", "jsonl"] as const) {
  test(
"repeated inputs execute once across queues, restart and reset with " + storage, async (t) => {
    const dir = await directory(t);
    const log = storage === "sqlite" ? createSqliteRuntimeLog(dir) : createRuntimeLog(dir);
    const replies: string[] = [];
    let calls = 0;
    const options = { ownerId: 42, dataDir: dir, log, answer: async () => { calls++; return "完成"; },
      send: async (text: string) => { replies.push(text); } };
    const app = createApp(options);
    let accepted = 0;
    await Promise.all([app.handle(update, () => { accepted++; }), app.handle(update, () => { accepted++; })]);
    assert.equal(calls, 1);
    assert.equal(accepted, 2, "duplicates must still release polling acceptance");
    await createApp(options).handle({ ...update, text: "/reset", messageId: 101 });
    await createApp(options).handle(update);
    assert.equal(calls, 1, "reset must not erase received input identities");
    await createApp(options).handle({ ...update, messageId: 102 });
    assert.equal(calls, 2, "a new message with identical text is a new request");
    assert.equal(replies.filter((text) => text === "完成").length, 2);
  });
}

test("legacy interrupted inputs are not executed again, including unknown tool outcomes", async (t) => {
  const dir = await directory(t);
  const log = createSqliteRuntimeLog(dir);
  await log.appendBatch([
    { type: "message", role: "user", text: update.text, messageId: update.messageId, requestId: "old" },
    { type: "request_started", requestId: "old" },
    { type: "tool_dispatch", requestId: "old", toolCallId: "write-1", toolName: "write" },
  ]);
  let calls = 0;
  const app = createApp({ ownerId: 42, dataDir: dir, log, answer: async () => { calls++; return "完成"; }, send: async () => {} });
  await app.recover();
  await app.handle(update);
  assert.equal(calls, 0);
  assert.equal((await log.read()).filter((event) => event.type === "request_started").length, 1);
  assert.ok((await log.read()).some((event) => event.type === "request_interrupted"));
});

test("duplicate commands cannot reset newer context or overwrite a newer prompt", async (t) => {
  const dir = await directory(t);
  const log = createSqliteRuntimeLog(dir);
  const replies: string[] = [];
  let calls = 0;
  const make = () => createApp({ ownerId: 42, dataDir: dir, log,
    answer: async () => { calls++; return "完成"; }, send: async (text) => { replies.push(text); } });
  const reset = { ...update, text: "/reset", messageId: 101 };
  const oldPrompt = { ...update, text: "/prompt set 旧提示词", messageId: 102 };
  await make().handle(reset);
  await make().handle(oldPrompt);
  await make().handle({ ...update, text: "/prompt set 新提示词", messageId: 103 });
  await make().handle(update);
  await make().handle(reset);
  await make().handle(oldPrompt);
  await make().handle({ ...update, text: "/prompt", messageId: 104 });
  const events = await log.read();
  assert.equal(events.filter((event) => event.type === "reset").length, 1);
  assert.equal(events.filter((event) => event.type === "bot_prompt_config").length, 2);
  assert.match(replies.at(-1)!, /新提示词/);
  assert.equal(calls, 1);
});

test("a failed input commit does not acknowledge or suppress a later retry", async (t) => {
  const dir = await directory(t);
  const base = createSqliteRuntimeLog(dir);
  let fail = true;
  let accepted = 0;
  let calls = 0;
  const log = { ...base, async appendBatch(events: Parameters<typeof base.appendBatch>[0]) {
    if (fail) { fail = false; throw new Error("input commit failed"); }
    return base.appendBatch(events);
  } };
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async () => { calls++; return "完成"; }, send: async () => {} });
  await assert.rejects(app.handle(update, () => { accepted++; }), /input commit failed/);
  assert.equal(accepted, 0); assert.equal(calls, 0); assert.deepEqual(await base.read(), []);
  await app.handle(update, () => { accepted++; });
  assert.equal(accepted, 1); assert.equal(calls, 1);
});

async function modelFixture(t: TestContext, responses: Array<{ type: string; text: string }>) {
  const dir = await directory(t);
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    const output = responses[calls++] ?? { type: "final", text: "测试兜底完成" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
"data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(output) }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: "http://127.0.0.1:" + address.port });
  t.after(() => agent.close());
  const log = createSqliteRuntimeLog(dir);
  const replies: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log, answer: agent.answer, send: async (text) => { replies.push(text); } });
  return { app, log, replies, calls: () => calls };
}

for (const scenario of ["repeated", "alternating", "distinct"] as const) {
  test("text-only " + scenario + " results cannot keep a request running indefinitely", async (t) => {
    const responses = Array.from({ length: 20 }, (_, index) => ({
      type: scenario === "alternating" && index % 2 ? "status" : "result",
      text: scenario === "distinct" ? "阶段 " + index : "相同成果",
    }));
    const f = await modelFixture(t, responses);
    await f.app.handle(update);
    assert.ok(f.calls() <= 12, "text-only continuation must be bounded");
    assert.match(f.replies.at(-1)!, /未完成/);
    assert.ok(!(await f.log.read()).some((event) => event.type === "delivery_succeeded"));
    responses.length = f.calls();
    await f.app.handle({ ...update, messageId: 101 });
    assert.equal(f.replies.at(-1), "测试兜底完成", "the next input must be able to leave the request queue");
  });
}

test("distinct useful text results can still lead to a final answer", async (t) => {
  const f = await modelFixture(t, [{ type: "result", text: "第一项结论" }, { type: "result", text: "第二项结论" },
    { type: "final", text: "最终结论" }]);
  await f.app.handle(update);
  assert.equal(f.calls(), 3);
  assert.equal(f.replies.at(-1), "最终结论");
});

test("nested Markdown quotes paginate without nested Telegram blockquotes or missing content", () => {
  const pages = planTelegramText(
"> 外层引用\n>\n> > 内层 **加粗**\n> >\n> > - 列表中的引用\n> >   > 更深层内容\n> >\n> > " + "长引用内容😀".repeat(1200));
  assert.ok(pages.length > 1);
  for (const page of pages) {
    let depth = 0;
    for (const tag of page.match(/<\/?blockquote>/g) ?? []) {
      depth += tag === "<blockquote>" ? 1 : -1;
      assert.ok(depth >= 0 && depth <= 1, "Telegram forbids nested blockquote entities");
    }
    assert.equal(depth, 0);
  }
  const html = pages.join("");
  assert.match(html, /外层引用/); assert.match(html, /<b>加粗<\/b>/); assert.match(html, /更深层内容/);
  assert.equal(html.replace(/<[^>]*>/g, "").match(/长引用内容😀/g)?.length, 1200);
});

test("streaming keeps full content while bounding snapshots and full history reads", { timeout: 30_000 }, async (t) => {
  const dir = await directory(t);
  const base = createSqliteRuntimeLog(dir);
  await base.appendBatch(Array.from({ length: 100 }, () => ({ type: "historical_diagnostic", text: "x".repeat(2000) })));
  let fullReads = 0;
  const log = { ...base, async read(afterSequence = 0) {
    if (!afterSequence) fullReads++;
    return base.read(afterSequence);
  } };
  const body = "流式正文abcdefgh".repeat(400);
  const encoded = JSON.stringify({ type: "final", text: body });
  let generated = false;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let at = 0; at < encoded.length; at += 80) {
      res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: encoded.slice(at, at + 80) }, finish_reason: null }] }) + "\n\n");
      await delay(10);
    }
    generated = true;
    res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: "http://127.0.0.1:" + address.port });
  t.after(() => agent.close());
  const sent: string[] = [];
  let previewBeforeCompletion = false;
  const app = createApp({ ownerId: 42, dataDir: dir, log, answer: agent.answer, send: async () => { throw new Error("use projection"); },
    telegram: { send: async (text) => { sent.push(text); return sent.length; }, edit: async () => {},
      draft: async () => { if (!generated) previewBeforeCompletion = true; } } });
  await app.handle(update);
  const events = await base.read();
  assert.equal(sent.join(""), body);
  assert.ok(previewBeforeCompletion, "coalescing must retain a live draft");
  assert.ok(events.filter((event) => event.type === "text_snapshot").length <= 20, "snapshot cadence must not follow every token");
  assert.ok(fullReads <= 15, "streaming must not reload all historical payloads for every preview");
  assert.ok(events.some((event) => event.type === "delivery_succeeded"));
});
