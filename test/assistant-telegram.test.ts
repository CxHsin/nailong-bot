import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Bot } from "grammy";
import { Response as ApiResponse } from "node-fetch";
import { connectTelegram } from "../src/assistant/telegram.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import type { ServerResponse } from "node:http";

const botInfo = {
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
const update = (id: number, actor = 42, photo = false) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 0,
    chat: { id: actor, type: "private" as const, first_name: "owner" },
    from: { id: actor, is_bot: false, first_name: "owner" },
    ...(photo
      ? {
          caption: "inspect photo",
          photo: [
            { file_id: "photo", file_unique_id: "photo", width: 1, height: 1 },
          ],
        }
      : { text: "hello" }),
  },
});

async function telegramFixture(
  provider: (wire: Wire, response: ServerResponse) => void,
  send?: (method: string, body: unknown) => ApiResponse | Promise<ApiResponse>,
) {
  const f = await assistantFixture(provider);
  const sent: Array<{ method: string; body: unknown }> = [];
  const errors: unknown[] = [];
  const bot = new Bot("test", {
    botInfo,
    client: {
      fetch: async (url, init) => {
        const method = String(url).split("/").at(-1)!;
        const body = init?.body;
        sent.push({ method, body });
        if (send) return send(method, body);
        return new ApiResponse(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 10,
              date: 0,
              chat: { id: 42, type: "private" },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  });
  const channel = await connectTelegram({
    app: f.app,
    bot,
    ownerId: 42,
    dataDir: f.directory,
    download: async () => ({
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPfoAAAAASUVORK5CYII=",
    }),
    reportFailure: (error) => {
      errors.push(error);
    },
  });
  return {
    ...f,
    bot,
    sent,
    errors,
    channel,
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

test("Telegram authenticates and deduplicates input and returns rich output from native Pi", async () => {
  let requests = 0;
  const f = await telegramFixture((_wire, response) => {
    requests++;
    sendChatCompletion(response, "**hello**");
  });
  try {
    await f.bot.handleUpdate(update(1, 43));
    await f.bot.handleUpdate(update(2));
    await f.bot.handleUpdate(update(2));
    await f.flush();
    assert.equal(requests, 1);
    assert.equal(
      f.sent.filter((call) => call.method === "sendRichMessage").length,
      1,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("Telegram photo reaches native Pi and a requested file reaches sendDocument", async () => {
  const f = await telegramFixture((wire, response) => {
    if (wire.messages.at(-1)?.role !== "tool") {
      assert.match(JSON.stringify(wire.messages), /data:image\/png;base64/);
      sendChatCompletion(response, "", [
        {
          index: 0,
          id: "file",
          type: "function",
          function: { name: "send_file", arguments: '{"path":"result.txt"}' },
        },
      ]);
    } else sendChatCompletion(response, "file delivered");
  });
  try {
    await writeFile(join(f.directory, "result.txt"), "photo result");
    await f.bot.handleUpdate(update(1, 42, true));
    await f.flush();
    assert.equal(
      f.sent.filter((call) => call.method === "sendDocument").length,
      1,
    );
    assert.deepEqual(f.errors, []);
    assert.match(
      await readFile(join(f.directory, "telegram-sends.jsonl"), "utf8"),
      /"status":"sent"/,
    );
  } finally {
    await f.close();
  }
});

test("definite Telegram format rejection falls back to plain blocks", async () => {
  let calls = 0;
  const bodies: string[] = [];
  const f = await telegramFixture(
    (_wire, response) => sendChatCompletion(response, "**hello**"),
    (method, body) => {
      if (method === "sendRichMessage") {
        bodies.push(String(body));
        if (++calls === 1)
          return new ApiResponse(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "cannot parse entities",
            }),
          );
      }
      return new ApiResponse(
        JSON.stringify({ ok: true, result: { message_id: 10 } }),
      );
    },
  );
  try {
    await f.bot.handleUpdate(update(1));
    await f.flush();
    assert.equal(calls, 2);
    assert.match(bodies[0]!, /markdown/);
    assert.match(bodies[1]!, /blocks/);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("ambiguous Telegram send is recorded without automatic retry", async () => {
  let calls = 0;
  const f = await telegramFixture(
    (_wire, response) => sendChatCompletion(response, "hello"),
    (method) => {
      if (method === "sendRichMessage") {
        calls++;
        throw new Error("connection lost after request");
      }
      return new ApiResponse(JSON.stringify({ ok: true, result: true }));
    },
  );
  try {
    await f.bot.handleUpdate(update(1));
    await f.flush();
    assert.equal(calls, 1);
    assert.ok(f.errors.length > 0);
    assert.match(
      await readFile(join(f.directory, "telegram-sends.jsonl"), "utf8"),
      /"status":"unknown"/,
    );
  } finally {
    await f.close();
  }
});
