import { Bot } from "grammy";
import { Response as ApiResponse } from "node-fetch";
import { connectTelegram } from "../../src/assistant/telegram.js";
import { assistantFixture, type Wire } from "./assistant.js";
import type { ServerResponse } from "node:http";

export const botInfo = {
  id: 1,
  is_bot: true as const,
  first_name: "test",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export async function telegramFixture(
  provider: (wire: Wire, response: ServerResponse) => void,
  send?: (method: string, body: unknown) => ApiResponse | Promise<ApiResponse>,
  downloadDocument: (id: string) => Promise<Buffer> = async (_id: string) => Buffer.from("attachment data"),
  configure?: Parameters<typeof assistantFixture>[1],
  onApi?: (method: string, body: unknown) => void,
) {
  const f = await assistantFixture(provider, configure, configure ? undefined : { primaryConversationId: "telegram:private:42", catalog: [{ id: "local", display_name: "local", reasoning: false, modalities: ["text", "image"] }] });
  const sent: Array<{ method: string; body: unknown; messageId: number }> = [];
  const errors: unknown[] = [];
  let nextMessageId = 1000;
  const createBot = () => new Bot("test", {
    botInfo,
    client: {
      fetch: async (url, init) => {
        const method = String(url).split("/").at(-1)!;
        const body = init?.body;
        const messageId = method === "editMessageText" ? JSON.parse(String(body)).message_id as number : ++nextMessageId;
        sent.push({ method, body, messageId });
        onApi?.(method, body);
        if (send) return send(method, body);
        return new ApiResponse(
          JSON.stringify({
            ok: true,
            result: {
              message_id: messageId,
              date: 0,
              chat: { id: 42, type: "private" },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  });
  let bot = createBot();
  const connect = () => connectTelegram({
    app: f.app,
    bot,
    ownerId: 42,
    dataDir: f.directory,
    download: async () => ({
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPfoAAAAASUVORK5CYII=",
    }),
    downloadDocument,
    reportFailure: (error) => {
      errors.push(error);
    },
  });
  let channel = await connect();
  return {
    ...f,
    get app() { return f.app; },
    get bot() { return bot; },
    sent,
    errors,
    get channel() { return channel; },
    async reopen() { await channel.close(); await f.reopen(); bot = createBot(); channel = await connect(); },
    async flush() {
      await channel.finish();
      await f.app.waitForIdle();
    },
    async close() {
      await channel.close();
      await f.close();
    },
  };
}
