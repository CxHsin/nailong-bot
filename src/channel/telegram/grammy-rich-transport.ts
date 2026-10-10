import type { Bot } from "grammy";
import { createTelegramRichTransport } from "./rich-transport.js";

/** Production and live acceptance use the same Bot API adapter. */
export function createGrammyRichTransport(api: Pick<Bot["api"], "sendRichMessage" | "sendRichMessageDraft">) {
  return createTelegramRichTransport({
    sendRich: async (chatId, markdown, signal) => (await api.sendRichMessage(chatId, { markdown }, undefined,
      signal as Parameters<typeof api.sendRichMessage>[3])).message_id,
    draftRich: async (draftId, chatId, markdown, signal) => { await api.sendRichMessageDraft(chatId, draftId, { markdown }, undefined,
      signal as Parameters<typeof api.sendRichMessageDraft>[4]); },
  });
}
