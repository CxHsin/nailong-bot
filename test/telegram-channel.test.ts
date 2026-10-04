import assert from "node:assert/strict";
import test from "node:test";
import { telegramConversationId, normalizeTelegramInput, createTelegramHostProjection, telegramEnvironment } from "../src/channel/telegram/index.js";
import type { HostEvent, RunHandle } from "../src/host/host.js";

test("Telegram input maps private identity to a stable Host conversation and ContentParts", () => {
  assert.equal(telegramConversationId(42), "telegram:private:42");
  const input = normalizeTelegramInput({ fromId: 42, chatId: 42, chatType: "private", messageId: 7, text: "看图", image: { mimeType: "image/jpeg", data: "aW1n" } });
  assert.deepEqual(input.actor, { id: "telegram:42", kind: "user" });
  assert.equal(input.conversationId, "telegram:private:42");
  assert.deepEqual(input.parts.map((part) => part.type), ["text", "image"]);
  assert.throws(() => normalizeTelegramInput({ fromId: 42, chatId: 99, chatType: "group", messageId: 1, text: "no" }), /private/);
});

test("Telegram Host projection converges one editable draft into one final message", async () => {
  const calls: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42, draft: async (_id, text) => { calls.push(`draft:${text}`); }, send: async (text) => { calls.push(`send:${text}`); return 9; }, edit: async () => {} });
  const events: HostEvent[] = [
    { type: "run_submitted", schemaVersion: 1, runId: "r1", conversationId: "c1", sequence: 1, at: "now" },
    { type: "progress", schemaVersion: 1, runId: "r1", conversationId: "c1", sequence: 2, at: "now", phase: "working", source: "provider", visibility: "normal", contextPolicy: "exclude", text: "处理中" },
    { type: "run_succeeded", schemaVersion: 1, runId: "r1", conversationId: "c1", sequence: 3, at: "now", result: { text: "完成" } },
  ];
  const handle = { runId: "r1", conversationId: "c1", events: async function* () { yield* events; }, done: Promise.resolve(events.at(-1)!), cancel: async () => false } as RunHandle;
  await projection.consume(handle);
  assert.deepEqual(calls, ["draft:处理中", "send:完成"]);
});

test("legacy Telegram environment variables remain accepted with migration guidance", () => {
  const warnings: string[] = [];
  const result = telegramEnvironment({ TELEGRAM_BOT_TOKEN: "old-token", TELEGRAM_USER_ID: "42" }, (message) => warnings.push(message));
  assert.deepEqual(result, { token: "old-token", ownerId: 42 });
  assert.equal(warnings.length, 1);
});
