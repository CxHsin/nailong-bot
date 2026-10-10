import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import { Response as FetchResponse } from "node-fetch";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { initializeTelegramHostChannel } from "../src/channel/telegram/host-channel.js";
import { createCliChannel } from "../src/cli/cli-channel.js";

test("Telegram startup registers owner commands before polling and routes authenticated command suffixes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-controls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const methods: Array<{ method: string; payload: Record<string, unknown> }> = [];
  class PollBot extends Bot { override async start() { methods.push({ method: "polling", payload: {} }); } }
  const bot = new PollBot("123:test", { client: { fetch: async (url, init) => {
    const method = String(url).split("/").at(-1)!;
    methods.push({ method, payload: JSON.parse(String(init?.body ?? "{}")) });
    return new FetchResponse(JSON.stringify({ ok: true, result: method === "getMe" ? { id: 123, is_bot: true, first_name: "bot", username: "test_bot" } : true }));
  } } });
  let modelCalls = 0;
  const log = createRuntimeLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log, agent: {
    answer: async () => { modelCalls++; return "answer"; },
  } });
  const responses: string[] = [];
  const animations: string[] = [];
  const channel = await initializeTelegramHostChannel({ bot, ownerId: 42, host,
    transport: { send: async (text) => { responses.push(text); return 1; },
      sendSticker: async (category, chatId) => { animations.push(category); assert.equal(chatId, 42); return 2; } },
    download: async () => ({ type: "image", mimeType: "image/png", data: "aW1n" }), reportFailure: (error) => { throw error; },
    onDelivered: (event, telegramMessageId) => host.recordDelivery(event, { channel: "telegram", telegramMessageId }) });
  await channel.start();
  const menu = methods.find((call) => call.method === "setMyCommands")!.payload;
  assert.deepEqual(menu.scope, { type: "chat", chat_id: 42 });
  assert.deepEqual((menu.commands as Array<{ command: string }>).map((item) => item.command), ["help", "kvcache", "model", "skill", "dance", "feed", "reset", "prompt", "forget", "memory"]);
  assert.equal(menu.language_code, undefined);
  assert.ok(methods.findIndex((call) => call.method === "setMyCommands") < methods.findIndex((call) => call.method === "polling"));
  let updateId = 0;
  const send = async (text: string, actor = 42, type: "private" | "group" = "private", photo = false, reply = false) => {
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 0,
      from: { id: actor, is_bot: false, first_name: "owner" }, chat: type === "group" ? { id: actor, type: "group", title: "group" } : { id: actor, type: "private", first_name: "owner" },
      ...(reply ? { reply_to_message: { message_id: 1, date: 0, chat: { id: 42, type: "private" as const, first_name: "owner" }, text: "answer", reply_to_message: undefined } } : {}),
      ...(photo ? { caption: text, photo: [{ file_id: "file", file_unique_id: "file", width: 1, height: 1 }] } : { text }) } });
    await channel.finish();
  };
  await send("/kvcache@test_bot"); assert.match(responses.at(-1)!, /暂无/);
  await send("/missing@test_bot"); assert.match(responses.at(-1)!, /未知命令/);
  await send("/kvcache@other_bot"); await send("/kvcache", 99); await send("/kvcache", 42, "group");
  assert.equal(responses.length, 2); assert.equal(modelCalls, 0);
  await send("/dance@test_bot");
  assert.deepEqual(animations, ["dance"]);
  assert.equal(responses.length, 2); assert.equal(modelCalls, 0);
  await send("/dance", 99); await send("/dance@other_bot");
  assert.equal(animations.length, 1);
  await send("/feed"); assert.deepEqual(animations, ["dance", "feed"]);
  assert.match(responses.at(-1)!, /小面包/);
  await send("/reset", 42, "private", true); assert.equal(modelCalls, 1);
  await send("remember value"); assert.equal(modelCalls, 2);
  await send("/forget", 42, "private", false, true);
  assert.match(responses.at(-1)!, /已排除/);
  assert.equal(modelCalls, 2);
});

test("menu registration failure preserves chat startup and CLI shares queued prompt controls", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "channel-fallback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let polled = false;
  class PollBot extends Bot { override async start() { polled = true; } }
  const bot = new PollBot("123:test", { client: { fetch: async (url) => new FetchResponse(JSON.stringify(
    String(url).endsWith("getMe") ? { ok: true, result: { id: 123, is_bot: true, first_name: "bot", username: "test_bot" } } :
      { ok: false, error_code: 400, description: "menu unavailable" })) } });
  const prompts: Array<string | undefined> = [];
  const host = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log: createRuntimeLog(dir), agent: {
    answer: async (_messages, request) => { prompts.push(request.botPrompt); return "answer"; },
  } });
  const errors: unknown[] = [];
  const channel = await initializeTelegramHostChannel({ bot, ownerId: 42, host,
    transport: { send: async () => 1 }, download: async () => { throw new Error("unused"); }, reportFailure: (error) => { errors.push(error); } });
  await channel.start();
  assert.equal(polled, true); assert.equal(errors.length, 1);
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0,
    from: { id: 42, is_bot: false, first_name: "owner" }, chat: { id: 42, type: "private", first_name: "owner" }, text: "/prompt set shared prompt" } });
  await channel.finish();
  const stdout: string[] = []; const stderr: string[] = [];
  const cli = createCliChannel({ host, actor: { id: "cli" }, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
  await cli.send("hello", { conversationId: "telegram:private:42", json: true });
  await cli.chat(["/help", "/kvcache", "/reset"], { conversationId: "telegram:private:42", json: true });
  assert.deepEqual(prompts, ["shared prompt"]);
  const events = stdout.map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.result?.cache?.conversationId === "telegram:private:42"));
  assert.ok(events.every((event) => event.runId && event.conversationId && Number.isSafeInteger(event.seq)));
  assert.deepEqual(stderr, []);
});

test("pure commands never publish a processing draft while their receipt is pending", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "command-draft-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = createRuntimeLog(dir);
  const log = { ...base, append: async (event: Parameters<typeof base.append>[0]) => {
    if (event.type === "run_succeeded") await new Promise((resolve) => setTimeout(resolve, 40));
    return base.append(event);
  } };
  const host = createAgentHost({ dataDir: dir, promptFile: "system-prompt.md", log, agent: { answer: async () => "answer" } });
  const { createTelegramHostProjection } = await import("../src/channel/telegram/projection.js");
  let drafts = 0;
  const projection = createTelegramHostProjection({ chatId: 42, draftIntervalMs: 1,
    draft: async () => { drafts++; }, send: async () => 1 });
  await projection.consume(host.submit({ actor: { id: "owner" }, conversationId: "c", text: "/feed" }));
  assert.equal(drafts, 0);
});

test("nailong picks only reviewed category stickers without consecutive repeats", async () => {
  const { NAILONG_STICKERS, createNailongStickerPicker } = await import("../src/channel/telegram/nailong-stickers.js");
  const pick = createNailongStickerPicker();
  for (const category of ["feed", "dance"] as const) {
    let last = "";
    for (let i = 0; i < 30; i++) {
      const current = pick(category);
      assert.ok(NAILONG_STICKERS[category].some((item) => item.fileId === current));
      assert.notEqual(current, last); last = current;
    }
  }
});
