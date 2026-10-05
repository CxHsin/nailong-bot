import { formatMarkdownForTelegram } from "../../telegram/telegram-format.js";
import { planTelegramText } from "../../telegram/telegram-layout.js";
import type { DeliveryContent } from "../../runtime/content-delivery.js";

export type TelegramRichTransportApi = {
  sendRich: (chatId: number, markdown: string) => Promise<number>;
  draftRich: (draftId: number, chatId: number, markdown: string, signal?: AbortSignal) => Promise<void>;
  sendHtml: (chatId: number, html: string) => Promise<number>;
  draftHtml: (draftId: number, chatId: number, html: string, signal?: AbortSignal) => Promise<void>;
};

type RichAvailability = "unknown" | "supported" | "unsupported";

function field(error: unknown, name: string): unknown {
  return error && typeof error === "object" ? (error as Record<string, unknown>)[name] : undefined;
}

/** Telegram uses 404/unknown-method responses when a Bot API method is unavailable. */
export function isRichApiUnavailable(error: unknown): boolean {
  const code = field(error, "error_code") ?? field(error, "status") ?? field(error, "statusCode");
  if (code === 404) return true;
  const description = [field(error, "description"), field(error, "message")]
    .filter((value): value is string => typeof value === "string").join(" ");
  return /(?:unknown|unsupported)\s+(?:method|endpoint)|(?:method|endpoint|route).*not found/i.test(description);
}

/**
 * Prefer Telegram's native Rich Markdown and fall back to the existing safe HTML
 * renderer only when the Bot API method itself is unavailable.
 */
export function createTelegramRichTransport(api: TelegramRichTransportApi) {
  let availability: RichAvailability = "unknown";

  async function sendHtml(text: string, chatId: number): Promise<number> {
    const chunks = planTelegramText(text);
    const planned = chunks.length ? chunks : [formatMarkdownForTelegram(text)];
    let firstMessageId: number | undefined;
    for (const chunk of planned) {
      const messageId = await api.sendHtml(chatId, chunk);
      firstMessageId ??= messageId;
    }
    if (firstMessageId === undefined) throw new Error("Telegram 回退消息为空");
    return firstMessageId;
  }

  async function draftHtml(draftId: number, text: string, chatId: number, signal?: AbortSignal): Promise<void> {
    const rendered = planTelegramText(text)[0] ?? formatMarkdownForTelegram(text);
    await api.draftHtml(draftId, chatId, rendered, signal);
  }

  function plan(content: DeliveryContent): string[] {
    const pages = planTelegramText(content.text);
    if (content.kind === "final") return pages;
    const title = content.source === "progress-model" ? "运行摘要" : "进展";
    return pages.map((page) => `<b>${title}</b>\n<blockquote expandable>${page.replace(/<\/?blockquote(?: expandable)?>/g, "")}</blockquote>`);
  }

  async function sendPage(text: string, chatId: number): Promise<number> {
    try { return await api.sendHtml(chatId, text); }
    catch (error) {
      const description = String(field(error, "description") ?? field(error, "message") ?? "");
      if (field(error, "error_code") !== 400 || !text.includes("<blockquote expandable>") ||
        !/parse|entity|blockquote|unsupported/i.test(description)) throw error;
      return api.sendHtml(chatId, text.replace(/<blockquote expandable>/g, "<blockquote>"));
    }
  }

  return {
    plan,
    sendPage,
    async sendProgress(text: string, chatId: number, source: "execution" | "progress-model"): Promise<number> {
      let first: number | undefined;
      for (const page of plan({ id: "", text, kind: "progress", source })) {
        const messageId = await sendPage(page, chatId);
        first ??= messageId;
      }
      if (first === undefined) throw new Error("Telegram 进展消息为空");
      return first;
    },
    async draft(draftId: number, text: string, chatId: number, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      if (availability !== "unsupported") {
        try {
          await api.draftRich(draftId, chatId, text, signal);
          signal?.throwIfAborted();
          availability = "supported";
          return;
        } catch (error) {
          signal?.throwIfAborted();
          if (!isRichApiUnavailable(error)) throw error;
          availability = "unsupported";
        }
      }
      signal?.throwIfAborted();
      await draftHtml(draftId, text, chatId, signal);
    },
    async send(text: string, chatId: number): Promise<number> {
      if (availability !== "unsupported") {
        try {
          const messageId = await api.sendRich(chatId, text);
          availability = "supported";
          return messageId;
        } catch (error) {
          if (!isRichApiUnavailable(error)) throw error;
          availability = "unsupported";
        }
      }
      return sendHtml(text, chatId);
    },
  };
}
