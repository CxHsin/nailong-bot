import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestServer } from "./fixtures/http-server.js";
import { closeFixture } from "./fixtures/cleanup.js";
import { createTelegramHostFixture } from "./fixtures/telegram-host.js";
import type { RuntimeLog, StoredEvent } from "../src/runtime/runtime-types.js";
import { createTelegramRichTransport, type TelegramRichTransportApi } from "../src/channel/telegram/rich-transport.js";

type WireMessage = { role: string; content?: unknown };

test("Telegram text retains delivery identity and context across duplicate input, restart and reset", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-host-fixture-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "Be helpful.");
  const wire: Array<{ messages: WireMessage[] }> = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    wire.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `reply-${wire.length}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let shutdown = async () => {};
  t.after(() => closeFixture({ server, dir, shutdown: () => shutdown() }));
  const f = await createTelegramHostFixture(t, { agentOptions: { dataDir: dir, promptFile,
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}`, model: "local", apiKey: "test" }] } } });
  shutdown = () => f.close();
  await f.sendUpdate({ update_id: 10, message: { message_id: 10, date: 0,
    from: { id: 7, is_bot: false, first_name: "stranger" }, chat: { id: 7, type: "private", first_name: "stranger" }, text: "unauthorized" } });
  await f.sendUpdate({ update_id: 11, message: { message_id: 11, date: 0,
    from: { id: 42, is_bot: false, first_name: "owner" }, chat: { id: -42, type: "supergroup", title: "group" }, text: "unauthorized" } });
  assert.equal(wire.length, 0);
  assert.deepEqual(await f.rootLog.read(), []);
  assert.deepEqual(f.sent, []);

  await f.send("first-original", { messageId: 12 });
  assert.equal(f.sent.at(-1), "reply-1");
  const first = (await f.scopedLog.read()).find((event) => event.type === "message" && event.role === "user");
  assert.ok(first?.requestId);
  const delivered = (await f.scopedLog.read()).find((event) => event.type === "delivery_succeeded" && event.requestId === first.requestId);
  assert.ok(delivered && typeof delivered.telegramMessageId === "number");
  assert.equal(delivered.conversationId, "telegram:private:42");
  assert.ok(f.deliveries.some((page) => page.messageId === delivered.telegramMessageId && page.text === "reply-1"));
  await f.send("first-original", { messageId: 12 });
  assert.equal(wire.length, 1);
  await f.restart();
  await f.send("first-original", { messageId: 12 });
  assert.equal(wire.length, 1, "durable input identity prevents another model call after restart");
  await f.send("follow-up", { replyToMessageId: delivered.telegramMessageId });
  assert.match(JSON.stringify(wire.at(-1)), /first-original/);
  assert.match(JSON.stringify(wire.at(-1)), /reply-1/);
  const replyInput = (await f.scopedLog.read()).find((event) => event.type === "message" && event.text === "follow-up");
  assert.equal(replyInput?.replyToMessageId, delivered.telegramMessageId);
  await f.send("/reset");
  assert.equal(wire.length, 2, "reset does not invoke the Provider");
  await f.send("fresh-question");
  const active = wire.at(-1)!.messages.filter((message) => !(typeof message.content === "string" && message.content.startsWith("长期记忆原文引用")));
  assert.doesNotMatch(JSON.stringify(active), /first-original|follow-up|reply-1|\/reset/);
  const facts = await f.rootLog.read();
  assert.ok(facts.some((event) => event.requestId === first.requestId && event.text === "first-original"));
  assert.equal(facts.filter((event) => event.type === "conversation_reset").length, 1);
  assert.equal(facts.filter((event) => event.type === "request_completed").length, 3);
  assert.ok(!facts.some((event) => event.type === "run_failed"));
  assert.deepEqual(f.failures, []);
  assert.ok(f.drafts.length > 0, "current native Rich drafts are exercised");
});

test("actual Telegram photos preserve model input when final Rich delivery is unknown and restart never redelivers it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-host-photo-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "Be helpful.");
  const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1cAAAAASUVORK5CYII=" };
  const wire: unknown[] = []; const downloaded: string[] = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    wire.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "photo-answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let shutdown = async () => {};
  t.after(() => closeFixture({ server, dir, shutdown: () => shutdown() }));
  let formalAttempts = 0;
  const f = await createTelegramHostFixture(t, { agentOptions: { dataDir: dir, promptFile,
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}`, model: "local", apiKey: "test" }] } },
    download: async (fileId: string) => { downloaded.push(fileId); return image; },
    createTransport: (api: TelegramRichTransportApi) => createTelegramRichTransport({ ...api,
      sendRich: async (chatId, text, signal) => {
        if (text === "photo-answer") { formalAttempts++; throw new Error("Telegram connection lost after send"); }
        return api.sendRich(chatId, text, signal);
      },
    }),
  });
  shutdown = () => f.close();
  await f.sendUpdate({ update_id: 1, message: { message_id: 1, date: 0,
    from: { id: 42, is_bot: false, first_name: "owner" }, chat: { id: 42, type: "private", first_name: "owner" }, caption: "photo-caption",
    photo: [{ file_id: "small", file_unique_id: "small", width: 10, height: 10 },
      { file_id: "large", file_unique_id: "large", width: 100, height: 100 }] } });
  assert.deepEqual(downloaded, ["large"]);
  assert.equal(wire.length, 1);
  assert.match(JSON.stringify(wire[0]), /photo-caption/);
  assert.ok(JSON.stringify(wire[0]).includes(`data:image/png;base64,${image.data}`));
  const facts = await f.rootLog.read();
  assert.ok(facts.some((event) => event.type === "answer_generated" && event.text === "photo-answer"));
  assert.ok(facts.some((event) => event.type === "run_succeeded"));
  assert.ok(facts.some((event) => event.type === "telegram_delivery_unknown"));
  assert.ok(!facts.some((event) => event.type === "delivery_succeeded" || event.type === "memory_learned"));
  assert.equal(formalAttempts, 1);
  await f.restart();
  assert.equal(formalAttempts, 1, "restart does not retry an unknown final delivery");
  assert.equal(wire.length, 1);
  assert.deepEqual(f.failures, []);
});

test("Telegram refuses a tool side effect when its durable dispatch cannot be committed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-host-dispatch-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "Be helpful.");
  const target = join(dir, "side-effect.txt");
  let modelCalls = 0; let rejectedDispatches = 0;
  const server = createTestServer(t, async (req, res) => {
    for await (const _chunk of req) { /* Drain the actual Provider request. */ }
    modelCalls++;
    const delta = modelCalls === 1 ? { tool_calls: [{ index: 0, id: "blocked_write", type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: target, content: "must not execute" }) } }] } : { content: "finished" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: modelCalls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let shutdown = async () => {};
  t.after(() => closeFixture({ server, dir, shutdown: () => shutdown() }));
  const f = await createTelegramHostFixture(t, { agentOptions: { dataDir: dir, promptFile,
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}`, model: "local", apiKey: "test" }] } },
    wrapLog: (log: RuntimeLog): RuntimeLog => {
      const check = (event: Omit<StoredEvent, "at">) => {
        if (event.type === "tool_dispatch") { rejectedDispatches++; throw new Error("database fixture rejected tool_dispatch"); }
      };
      return { ...log,
        append: async (event) => { check(event); return log.append(event); },
        appendBatch: async (events) => { for (const event of events) check(event); return log.appendBatch!(events); },
      };
    },
  });
  shutdown = () => f.close();
  await f.send("write the file");
  assert.ok(rejectedDispatches > 0);
  assert.equal(modelCalls, 1, "the failed dispatch cannot lead to another model step");
  await assert.rejects(readFile(target), { code: "ENOENT" });
  const facts = await f.rootLog.read();
  const input = facts.find((event) => event.type === "message" && event.role === "user");
  assert.ok(input?.requestId);
  assert.ok(facts.some((event) => event.type === "tool_call" && event.toolCallId === "blocked_write" && event.requestId === input.requestId));
  assert.ok(facts.some((event) => event.type === "run_failed" && event.runId === input.requestId));
  assert.ok(!facts.some((event) => event.type === "tool_dispatch" || event.type === "delivery_succeeded"));
  assert.ok(f.sent.some((text) => text.includes("这条消息处理失败")));
  await f.restart();
  assert.equal(modelCalls, 1, "restart does not repeat the refused tool or Provider request");
  await assert.rejects(readFile(target), { code: "ENOENT" });
});

test("raw legacy facts keep their identities and ownerless facts do not acquire a Conversation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-host-identity-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "Be helpful.");
  let shutdown = async () => {};
  t.after(async () => { await shutdown(); await rm(dir, { recursive: true, force: true }); });
  const f = await createTelegramHostFixture(t, { agentOptions: { dataDir: dir, promptFile,
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions",
      baseUrl: "http://127.0.0.1:9", model: "local", apiKey: "test" }] } } });
  shutdown = () => f.close();
  await f.rootLog.append({ type: "message", requestId: "ownerless-old", role: "user", text: "no durable owner" });
  await f.rootLog.append({ type: "message", requestId: "owned-old", chatId: 42, role: "user", text: "old chat identity" });
  await f.scopedLog.append({ type: "message", requestId: "scoped-current", role: "user", text: "explicit Conversation" });
  const original = await f.rootLog.read();
  assert.equal(original.find((event) => event.requestId === "ownerless-old")?.conversationId, undefined);
  assert.equal(original.find((event) => event.requestId === "owned-old")?.conversationId, undefined);
  assert.equal(original.find((event) => event.requestId === "scoped-current")?.conversationId, "telegram:private:42");
  assert.deepEqual((await f.scopedLog.read()).map((event) => event.requestId), ["owned-old", "scoped-current"]);
  const oldAgent = f.agent; const oldHost = f.host;
  await f.restart();
  assert.notEqual(f.agent, oldAgent); assert.notEqual(f.host, oldHost);
  assert.deepEqual(await f.rootLog.read(), original, "restart preserves exact raw event identities, sequence and ownership");
  assert.deepEqual((await f.scopedLog.read()).map((event) => event.requestId), ["owned-old", "scoped-current"]);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.failures, []);
});
