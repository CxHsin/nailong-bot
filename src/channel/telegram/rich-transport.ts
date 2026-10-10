import { planTelegramMarkdown } from "../../telegram/telegram-markdown.js";
import type { DeliveryContent } from "../../runtime/content-delivery.js";

export type TelegramRichTransportApi = {
  sendRich: (chatId: number, markdown: string, signal?: AbortSignal) => Promise<number>;
  draftRich: (draftId: number, chatId: number, markdown: string, signal?: AbortSignal) => Promise<void>;
};

/** Drafts and persisted messages share Telegram's native Rich Markdown format. */
export function createTelegramRichTransport(api: TelegramRichTransportApi) {
  function plan(content: DeliveryContent): string[] {
    return planTelegramMarkdown(content.text);
  }

  async function sendPage(markdown: string, chatId: number, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    try { return await api.sendRich(chatId, markdown, signal); }
    catch (error) { signal?.throwIfAborted(); throw error; }
  }

  async function send(text: string, chatId: number): Promise<number> {
    let firstMessageId: number | undefined;
    for (const page of planTelegramMarkdown(text)) {
      const id = await sendPage(page, chatId);
      firstMessageId ??= id;
    }
    if (firstMessageId === undefined) throw new Error("Telegram 消息为空");
    return firstMessageId;
  }

  return {
    nativeStream: true,
    plan,
    sendPage,
    sendProgress: (text: string, chatId: number, _source: "execution" | "progress-model") => send(text, chatId),
    async draft(draftId: number, markdown: string, chatId: number, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      // Rich previews have a 32768-character limit; retain the latest valid page
      // while the complete text remains available for immutable settlement pages.
      const preview = markdown.length > 32768 ? planTelegramMarkdown(markdown).at(-1) ?? "" : markdown;
      try { await api.draftRich(draftId, chatId, preview, signal); }
      catch (error) { signal?.throwIfAborted(); throw error; }
      signal?.throwIfAborted();
    },
    send,
  };
}
