import type { TestContext } from "node:test";
import { Bot } from "grammy";
import type { Update as TelegramUpdate } from "grammy/types";
import type { ImageContent } from "@mariozechner/pi-ai";
import { Response as ApiResponse } from "node-fetch";
import { createPiAgent, type PiAgentOptions } from "../../src/agent/pi-agent.js";
import { createAgentHost } from "../../src/application/agent-host.js";
import { initializeTelegramHostChannel } from "../../src/channel/telegram/host-channel.js";
import { createTelegramRichTransport, type TelegramRichTransportApi } from "../../src/channel/telegram/rich-transport.js";
import type { TelegramHostTransport } from "../../src/channel/telegram/index.js";
import { createRuntimeEventLog } from "../../src/runtime/event-log.js";
import { conversationLog } from "../../src/runtime/conversation-log.js";
import { acquireHostOwnership } from "../../src/runtime/host-ownership.js";
import type { RuntimeLog } from "../../src/runtime/runtime-types.js";

export type TelegramTextUpdateOptions = { messageId?: number; updateId?: number; replyToMessageId?: number };
export type TelegramHostFixtureOptions = { agentOptions: PiAgentOptions; ownerId?: number;
  wrapLog?: (durable: RuntimeLog) => RuntimeLog;
  download?: (fileId: string) => Promise<ImageContent>;
  createTransport?: (recordingApi: TelegramRichTransportApi) => TelegramHostTransport };

/** Actual production assembly; callers own their Provider, temp directory and wire assertions. */
export async function createTelegramHostFixture(t: TestContext, options: TelegramHostFixtureOptions) {
  const ownerId = options.ownerId ?? 42;
  const { dataDir, promptFile } = options.agentOptions;
  const conversationId = `telegram:private:${ownerId}`;
  const sent: string[] = [];
  const deliveries: Array<{ messageId: number; chatId: number; text: string }> = [];
  const drafts: Array<{ draftId: number; chatId: number; text: string }> = [];
  const notices: string[] = [];
  const failures: unknown[] = [];
  let nextDeliveryId = 1000;
  let nextMessageId = 0;
  let nextUpdateId = 0;
  type Connection = { rootLog: Awaited<ReturnType<typeof createRuntimeEventLog>>;
    agent: Awaited<ReturnType<typeof createPiAgent>>; host: ReturnType<typeof createAgentHost>;
    bot: Bot; channel: Awaited<ReturnType<typeof initializeTelegramHostChannel>>;
    ownership: Awaited<ReturnType<typeof acquireHostOwnership>> };
  let connection: Connection | undefined;
  let closing: Promise<void> | undefined;
  function current() {
    if (!connection) throw new Error("Telegram fixture is not connected");
    return connection;
  }
  async function close() {
    if (closing) return closing;
    const previous = connection;
    connection = undefined;
    if (!previous) return;
    closing = (async () => {
      try { await previous.channel.finish(); }
      finally {
        try { await previous.agent.close(); }
        finally { previous.ownership.release(); }
      }
    })();
    try { await closing; } finally { closing = undefined; }
  }
  t.after(close);
  async function connect() {
    const ownership = await acquireHostOwnership(dataDir);
    let agent: Connection["agent"] | undefined;
    try {
      const rootLog = await createRuntimeEventLog(dataDir);
      agent = await createPiAgent({ memoryBootstrap: false, ...options.agentOptions });
      const host = createAgentHost({ log: options.wrapLog?.(rootLog) ?? rootLog, dataDir, promptFile, agent });
      await host.recoverInterrupted();
      const bot = new Bot("123:test", { client: { fetch: async (url, init) => {
        const method = new URL(String(url)).pathname.split("/").at(-1);
        let result: unknown;
        if (method === "getMe") result = { id: 123, is_bot: true, first_name: "bot", username: "test_bot" };
        else if (method === "setMyCommands" || method === "setChatMenuButton") result = true;
        else if (method === "sendMessage") {
          const payload = JSON.parse(String(init?.body));
          notices.push(payload.text);
          result = { message_id: ++nextDeliveryId, date: 0, chat: { id: payload.chat_id, type: "private", first_name: "owner" }, text: payload.text };
        } else throw new Error(`Unexpected Telegram fixture API: ${method}`);
        return new ApiResponse(JSON.stringify({ ok: true, result }));
      } } });
      const recordingApi: TelegramRichTransportApi = {
        async sendRich(chatId, text, signal) {
          signal?.throwIfAborted();
          const messageId = ++nextDeliveryId;
          deliveries.push({ messageId, chatId, text }); sent.push(text);
          return messageId;
        },
        async draftRich(draftId, chatId, text, signal) {
          signal?.throwIfAborted(); drafts.push({ draftId, chatId, text });
        },
      };
      const transport = (options.createTransport ?? createTelegramRichTransport)(recordingApi);
      const channel = await initializeTelegramHostChannel({ bot, ownerId, host, transport,
        download: options.download ?? (async () => { throw new Error("unused photo fixture"); }), reportFailure: (error) => failures.push(error),
        onDelivered: (event, telegramMessageId) => host.recordDelivery(event, { channel: "telegram", telegramMessageId }) });
      connection = { rootLog, agent, host, bot, channel, ownership };
    } catch (error) {
      try { await agent?.close(); } finally { ownership.release(); }
      throw error;
    }
  }
  await connect();
  async function sendUpdate(update: TelegramUpdate) {
    nextUpdateId = Math.max(nextUpdateId, update.update_id);
    if (update.message) nextMessageId = Math.max(nextMessageId, update.message.message_id);
    const { bot, channel } = current();
    await bot.handleUpdate(update);
    await channel.finish();
  }
  return {
    dataDir, conversationId, sent, deliveries, drafts, notices, failures,
    get rootLog() { return current().rootLog; },
    get scopedLog() { return conversationLog(current().rootLog, conversationId); },
    get agent() { return current().agent; },
    get host() { return current().host; },
    get bot() { return current().bot; },
    sendUpdate,
    async send(text: string, metadata: TelegramTextUpdateOptions = {}) {
      const messageId = metadata.messageId ?? ++nextMessageId;
      const updateId = metadata.updateId ?? ++nextUpdateId;
      const chat = { id: ownerId, type: "private" as const, first_name: "owner" };
      await sendUpdate({ update_id: updateId, message: { message_id: messageId, date: 0,
        from: { id: ownerId, is_bot: false, first_name: "owner" }, chat, text,
        ...(metadata.replyToMessageId !== undefined ? { reply_to_message: {
          message_id: metadata.replyToMessageId, date: 0, chat,
          from: { id: 123, is_bot: true, first_name: "bot" }, text: "previous reply",
          reply_to_message: undefined,
        } } : {}),
      } });
    },
    accepted: () => current().channel.accepted(),
    finish: () => current().channel.finish(),
    async restart(beforeOpen?: () => Promise<void>) { await close(); await beforeOpen?.(); await connect(); },
    close,
  };
}

export type TelegramHostFixture = Awaited<ReturnType<typeof createTelegramHostFixture>>;
