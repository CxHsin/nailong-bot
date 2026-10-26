import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTelegramInput } from "../src/telegram/telegram-input.js";
import { Bot } from "grammy";
import { Response as ApiResponse } from "node-fetch";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { assistantFixture } from "./fixtures/assistant.js";
import { botInfo } from "./fixtures/telegram.js";
import { connectTelegram } from "../src/assistant/telegram.js";
import { AssistantState } from "../src/assistant/state.js";

/**
 * A dropped update used to leave no evidence anywhere: no log, no reply, no queue entry.
 * These tests pin the observability that makes such a drop diagnosable.
 */

type Handler = (ctx: any) => Promise<void>;

/** Minimal grammy stand-in: captures the single registered handler. */
function fakeBot() {
  let handler: Handler | undefined;
  const bot = { on: (_filters: unknown, middleware: Handler) => { handler = middleware; } };
  return { bot: bot as any, run: (ctx: any) => handler!(ctx) };
}

function context(message: any, overrides: Record<string, unknown> = {}) {
  const replies: string[] = [];
  return {
    message,
    from: { id: 1 },
    chat: { id: 1, type: "private" },
    me: { id: 999 },
    reply: async (text: string) => { replies.push(text); },
    replies,
    ...overrides,
  };
}

test("a received update is logged before any filtering, so a drop is traceable", async () => {
  const { bot, run } = fakeBot();
  const lines: string[] = [];
  registerTelegramInput(bot, {
    ownerId: 1, botUsername: "nailong_bot",
    download: async () => { throw new Error("unused"); },
    handle: async () => {},
    reportFailure: () => { throw new Error("receiving must not report a failure"); },
    log: (line) => { lines.push(line); },
  });
  // Wrong owner: the update must still be visible as received, then as ignored with the reason.
  await run(context({ message_id: 42, text: "look at this" }, { from: { id: 2 } }));
  const logged = lines.join("\n");
  assert.match(logged, /received message_id=42 kind=text chars=\d+ document=none/);
  assert.match(logged, /ignored message_id=42: from=2 chat=1 type=private owner=1/);
});

test("a document update logs its file name and size before downloading", async () => {
  const { bot, run } = fakeBot();
  const lines: string[] = [];
  registerTelegramInput(bot, {
    ownerId: 1, botUsername: "nailong_bot",
    download: async () => { throw new Error("unused"); },
    document: async () => "Saved attachment: x",
    handle: async (_input, started) => { started(); },
    reportFailure: () => {},
    log: (line) => { lines.push(line); },
  });
  await run(context({ message_id: 7, caption: "sent together",
    document: { file_id: "f", file_name: "notes.pdf", file_size: 2_900_000 } }));
  const logged = lines.join("\n");
  assert.match(logged, /received message_id=7 kind=document chars=\d+/);
  assert.match(logged, /notes\.pdf 2900000B/);
});

test("a document read failure is logged with its cause and still replies to the owner", async () => {
  const { bot, run } = fakeBot();
  const failures: string[] = [];
  registerTelegramInput(bot, {
    ownerId: 1, botUsername: "nailong_bot",
    download: async () => { throw new Error("unused"); },
    document: async () => { throw new Error("download timed out"); },
    handle: async () => { throw new Error("must not run"); },
    reportFailure: (error) => { failures.push(String(error)); },
  });
  const ctx = context({ message_id: 8, caption: "x", document: { file_id: "f", file_name: "a.pdf", file_size: 1 } });
  await run(ctx);
  assert.match(failures.join("\n"), /document failed message_id=8: download timed out/);
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0]!, /这条消息尚未开始处理/);
});

test("a handler failure before started() reports uncertainty without asking the owner to resend", async () => {
  const { bot, run } = fakeBot();
  const failures: string[] = [];
  registerTelegramInput(bot, {
    ownerId: 1, botUsername: "nailong_bot",
    download: async () => { throw new Error("unused"); },
    // Mirrors app.receive() throwing before started() is called.
    handle: async () => { throw new Error("service closed"); },
    reportFailure: (error) => { failures.push(String(error)); },
  });
  const ctx = context({ message_id: 9, text: "a message that fails" });
  await run(ctx);
  const logged = failures.join("\n");
  assert.match(logged, /handle failed message_id=9 started=false: service closed/);
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0]!, /无法确认处理状态/);
  assert.match(ctx.replies[0]!, /\/work/);
  assert.doesNotMatch(ctx.replies[0]!, /没有进入处理队列|请重新发送/);
});

test("a handler failure after started() is reported without a misleading retry reply", async () => {
  const { bot, run } = fakeBot();
  const failures: string[] = [];
  registerTelegramInput(bot, {
    ownerId: 1, botUsername: "nailong_bot",
    download: async () => { throw new Error("unused"); },
    handle: async (_input, started) => { started(); throw new Error("later failure"); },
    reportFailure: (error) => { failures.push(String(error)); },
  });
  const ctx = context({ message_id: 10, text: "accepted then failed" });
  await run(ctx);
  assert.match(failures.join("\n"), /handle failed message_id=10 started=true: later failure/);
  assert.equal(ctx.replies.length, 0, "an accepted message must not be told to resend");
});

test("a post-persistence failure retains the queued input without a misleading resend instruction", { timeout: 60_000 }, async (t) => {
  const conversationId = "telegram:private:42";
  const f = await assistantFixture(() => assert.fail("no model should run"), undefined,
    { selectedModel: null, primaryConversationId: conversationId, catalog: [] });
  const failures: unknown[] = [];
  let replySent!: (text: string) => void;
  const reply = new Promise<string>(resolve => { replySent = resolve; });
  const bot = new Bot("test", { botInfo, client: { fetch: async (_url, init) => {
    replySent((JSON.parse(String(init?.body)) as { text: string }).text);
    return new ApiResponse(JSON.stringify({ ok: true, result: {
      message_id: 1000, date: 0, chat: { id: 42, type: "private" },
    } }));
  } } });
  const channel = await connectTelegram({ app: f.app, bot, ownerId: 42, dataDir: f.directory,
    download: async () => { throw new Error("unused"); }, reportFailure: error => { failures.push(error); } });
  try {
    await f.app.waitForRouting();
    // The queue commit precedes saving the waiting-model reply's output metadata.
    t.mock.method(AssistantState.prototype, "saveOutputTargets", () => { throw new Error("SQLITE_FULL: output state write failed"); });
    await bot.handleUpdate({ update_id: 700, message: {
      message_id: 700, date: 0, chat: { id: 42, type: "private", first_name: "owner" },
      from: { id: 42, is_bot: false, first_name: "owner" }, text: "帮我执行这项工作",
    } });
    await channel.finish();
    const text = await reply;
    const db = new DatabaseSync(join(f.options.dataDir, "queue.sqlite"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inputs WHERE input_id='700' AND source='telegram'").get()!.count, 1);
    } finally { db.close(); }
    assert.match(failures.map(String).join("\n"), /started=false: SQLITE_FULL/);
    assert.match(text, /无法确认处理状态/);
    assert.match(text, /\/work/);
    assert.doesNotMatch(text, /没有进入处理队列|请重新发送/);
    const repeated = await f.app.receive({ conversationId, inputId: "700", source: "telegram", text: "帮我执行这项工作" });
    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.accepted, false);
  } finally {
    t.mock.restoreAll();
    await channel.close();
    await f.close();
  }
});
