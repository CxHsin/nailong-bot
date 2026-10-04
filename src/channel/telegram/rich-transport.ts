import { formatMarkdownForTelegram } from "../../telegram/telegram-format.js";
import { planTelegramText } from "../../telegram/telegram-layout.js";

export type TelegramRichTransportApi = {
  sendRich: (chatId: number, markdown: string) => Promise<number>;
  draftRich: (draftId: number, chatId: number, markdown: string) => Promise<void>;
  sendHtml: (chatId: number, html: string) => Promise<number>;
  draftHtml: (draftId: number, chatId: number, html: string) => Promise<void>;
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

  async function draftHtml(draftId: number, text: string, chatId: number): Promise<void> {
    const rendered = planTelegramText(text)[0] ?? formatMarkdownForTelegram(text);
    await api.draftHtml(draftId, chatId, rendered);
  }

  return {
    async draft(draftId: number, text: string, chatId: number): Promise<void> {
      if (availability !== "unsupported") {
        try {
          await api.draftRich(draftId, chatId, text);
          availability = "supported";
          return;
        } catch (error) {
          if (!isRichApiUnavailable(error)) throw error;
          availability = "unsupported";
        }
      }
      await draftHtml(draftId, text, chatId);
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
