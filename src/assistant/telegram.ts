import { InputFile, type Bot } from "grammy";
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ImageContent } from "@mariozechner/pi-ai";
import { registerTelegramInput } from "../telegram/telegram-input.js";
import { richReplyPages, textOnlyMarkdown } from "../telegram/rich-reply.js";
import type { Assistant } from "./runtime.js";
import { createDraftPreview } from "../telegram/draft-preview.js";

export async function connectTelegram(options: {
  app: Assistant;
  bot: Bot;
  ownerId: number;
  dataDir: string;
  download: (id: string) => Promise<ImageContent>;
  reportFailure: (error: unknown) => void;
}) {
  const { app, bot, ownerId, reportFailure } = options;
  const conversationId = `telegram:private:${ownerId}`;
  await mkdir(options.dataDir, { recursive: true });
  const receipts = join(options.dataDir, "telegram-sends.jsonl");
  const record = (value: unknown) =>
    appendFile(
      receipts,
      `${JSON.stringify({ at: Date.now(), ...(value as object) })}\n`,
    );
  const drafts = createDraftPreview({
    reportFailure,
    send: async (id, text) => {
      const page = richReplyPages(text).at(-1);
      if (!page?.text.trim()) return;
      return bot.api.sendRichMessageDraft(
        ownerId,
        id,
        page.textFormat === "plain"
          ? { blocks: [{ type: "paragraph", text: page.text }] }
          : { markdown: textOnlyMarkdown(page.text) },
      );
    },
  });
  const unsubscribePreviews = app.subscribePreviews((preview) => {
    if (preview.conversationId === conversationId) drafts.update(preview);
  });
  async function send(
    kind: string,
    action: () => Promise<{ message_id: number }>,
  ) {
    const id = randomUUID();
    await record({ id, kind, status: "sending" });
    try {
      const result = await drafts.withoutDrafts(action);
      await record({ id, status: "sent", messageId: result.message_id });
    } catch (error) {
      const failure = error as { error_code?: number };
      await record({ id, status: failure.error_code ? "rejected" : "unknown" });
      reportFailure(error);
      throw error;
    }
  }
  const unsubscribe = app.subscribe(async (output) => {
    if (output.conversationId !== conversationId) return;
    if (output.type === "file") {
      await send("file", () =>
        bot.api.sendDocument(ownerId, new InputFile(output.path)),
      );
      return;
    }
    for (const page of richReplyPages(output.text)) {
      try {
        await send("text", async () => {
          const plain = {
            blocks: [{ type: "paragraph" as const, text: page.text }],
          };
          try {
            return await bot.api.sendRichMessage(
              ownerId,
              page.textFormat === "plain"
                ? plain
                : { markdown: textOnlyMarkdown(page.text) },
            );
          } catch (error) {
            const failure = error as {
              error_code?: number;
              description?: string;
            };
            if (
              page.textFormat === "plain" ||
              failure.error_code !== 400 ||
              !/pars|format|rich|block|entit/i.test(failure.description ?? "")
            )
              throw error;
            return bot.api.sendRichMessage(ownerId, plain);
          }
        });
      } catch {
        /* Receipts retain rejection/ambiguity; later pages can still be delivered. */
      }
    }
  });
  const input = registerTelegramInput(bot, {
    ownerId,
    botUsername: bot.botInfo.username,
    download: options.download,
    reportFailure,
    async handle(update, started) {
      await app.receive({
        conversationId,
        inputId: String(update.messageId),
        text: update.text ?? "请分析这张图片。",
        images: update.images,
      });
      started();
    },
  });
  return {
    ...input,
    async close() {
      await input.finish();
      await app.waitForIdle();
      unsubscribe();
      unsubscribePreviews();
      await drafts.close();
    },
  };
}
