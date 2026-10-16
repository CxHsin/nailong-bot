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
    identity?: { outputId?: string; conversationId: string; path?: string },
  ) {
    const id = randomUUID();
    await record({ id, kind, ...identity, status: "sending" });
    try {
      const result = await drafts.withoutDrafts(action);
      await record({ id, status: "sent", messageId: result.message_id });
      if (identity?.outputId) app.recordReply(identity.conversationId,String(result.message_id),identity.outputId);
    } catch (error) {
      const failure = error as { error_code?: number };
      await record({ id, status: failure.error_code ? "rejected" : "unknown" });
      reportFailure(error);
      if (!failure.error_code) throw Object.assign(new Error(`Telegram delivery ${id} has an unknown external result. Inspect receipt ${receipts}; do not resend without verification.`, { cause: error }),
        { externalEffectUnknown: true, receiptPath: receipts, deliveryId: id });
      throw error;
    }
  }
  const unsubscribe = app.subscribe(async (output) => {
    if (output.conversationId !== conversationId) return;
    if (output.type === "file") {
      await send("file", () =>
        bot.api.sendDocument(ownerId, new InputFile(output.path)),
        { outputId: output.outputId, conversationId: output.conversationId, path: output.path },
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
        }, {outputId:output.outputId,conversationId:output.conversationId});
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
        source: "telegram",
        text: update.text ?? "请分析这张图片。",
        userText: update.text ?? "",
        replyToMessageId: update.replyToMessageId === undefined ? undefined : String(update.replyToMessageId),
        replyToMessage: update.replyToMessage,
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
