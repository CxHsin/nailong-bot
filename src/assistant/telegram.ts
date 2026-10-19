import { InputFile, type Bot } from "grammy";
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ImageContent } from "@mariozechner/pi-ai";
import { registerTelegramInput } from "../telegram/telegram-input.js";
import { richReplyPages, textOnlyMarkdown } from "../telegram/rich-reply.js";
import type { Assistant } from "./runtime.js";
import { createDraftPreview } from "../telegram/draft-preview.js";
import { saveTelegramDocument } from "./telegram-documents.js";
import { registerTelegramPanel } from "./telegram-panel.js";
import type { ReactionTypeEmoji } from "grammy/types";

export async function connectTelegram(options: {
  app: Assistant;
  bot: Bot;
  ownerId: number;
  dataDir: string;
  download: (id: string) => Promise<ImageContent>;
  downloadDocument?: (id: string) => Promise<Buffer>;
  reportFailure: (error: unknown) => void;
}) {
  const { app, bot, ownerId, reportFailure } = options;
  const conversationId = `telegram:private:${ownerId}`;
  await mkdir(options.dataDir, { recursive: true });
  const receipts = join(options.dataDir, "telegram-sends.jsonl");
  let draftsEnabled = (await app.controlSnapshot(conversationId)).drafts;
  let previewGeneration = 0;
  const record = (value: unknown) =>
    appendFile(
      receipts,
      `${JSON.stringify({ at: Date.now(), ...(value as object) })}\n`,
    );
  const drafts = createDraftPreview({
    reportFailure,
    send: async (id, text) => {
      if (!draftsEnabled) return;
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
    if (draftsEnabled && preview.conversationId === conversationId)
      drafts.update({ ...preview, replyId: `${preview.replyId}:preview:${previewGeneration}` });
  });
  async function send(
    kind: string,
    action: () => Promise<{ message_id: number }>,
    identity?: { outputId?: string; startupId?: string; conversationId: string; path?: string },
  ) {
    const id = randomUUID();
    await record({ id, kind, ...identity, status: "sending" });
    try {
      const result = identity?.startupId ? await action() : await drafts.withoutDrafts(action);
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
  const unregisterInteractions = app.registerTelegramInteractions(conversationId,{
    async getStickerSet(name) {return (await bot.api.getStickerSet(name)).stickers;},
    async express(action) {
      if((await app.controlSnapshot(conversationId)).expressionFrequency === "quiet" && !action.explicit)
        throw Object.assign(new Error("安静档不主动发送互动。"),{rejected:true});
      const identity={conversationId,outputId:action.operationId};
      if(action.kind === "sticker") {
        // Only identities resolved from the saved library reach this Channel action.
        await send("sticker",()=>bot.api.sendSticker(ownerId,action.sticker.fileId),identity);
      } else {
        if(!app.telegramMessageKnown(conversationId,action.messageId)) throw Object.assign(new Error("未核对的私聊消息目标。"),{rejected:true});
        // Bot API ReactionTypeEmoji vocabulary; arbitrary Unicode emoji are not valid reactions.
        const supported: ReactionTypeEmoji["emoji"][] = ["👍","👎","❤","🔥","🥰","👏","😁","🤔","🤯","😱","🤬","😢","🎉","🤩","🤮","💩","🙏","👌","🕊","🤡","🥱","🥴","😍","🐳","❤‍🔥","🌚","🌭","💯","🤣","⚡","🍌","🏆","💔","🤨","😐","🍓","🍾","💋","🖕","😈","😴","😭","🤓","👻","👨‍💻","👀","🎃","🙈","😇","😨","🤝","✍","🤗","🫡","🎅","🎄","☃","💅","🤪","🗿","🆒","💘","🙉","🦄","😘","💊","🙊","😎","👾","🤷‍♂","🤷","🤷‍♀","😡"];
        const chat = await bot.api.getChat(ownerId).catch(error=>{throw Object.assign(error,{rejected:true});});
        if(!supported.some(emoji=>emoji === action.emoji) || (chat.available_reactions && !chat.available_reactions.some(reaction=>reaction.type === "emoji" && reaction.emoji === action.emoji)))
          throw Object.assign(new Error("此聊天不支持该机器人表情回应，请选择实际可用类型。"),{rejected:true});
        await send("reaction",async()=>{
          await bot.api.setMessageReaction(ownerId,action.messageId,[{type:"emoji",emoji:action.emoji as ReactionTypeEmoji["emoji"]}]);
          return {message_id:action.messageId};
        },identity);
      }
    },
  });
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
      const textFormat = output.textFormat === "plain" ? "plain" : page.textFormat;
      try {
        await send("text", async () => {
          const plain = {
            blocks: [{ type: "paragraph" as const, text: page.text }],
          };
          try {
            return await bot.api.sendRichMessage(
              ownerId,
              textFormat === "plain"
                ? plain
                : { markdown: textOnlyMarkdown(page.text) },
            );
          } catch (error) {
            const failure = error as {
              error_code?: number;
              description?: string;
            };
            if (
              textFormat === "plain" ||
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
  registerTelegramPanel({ app, bot, ownerId, conversationId, reportFailure,
    async draftsChanged(enabled) {
      if (enabled && !draftsEnabled) previewGeneration++;
      draftsEnabled = enabled;
      if (!enabled) await drafts.stop();
    },
  });
  const input = registerTelegramInput(bot, {
    ownerId,
    botUsername: bot.botInfo.username,
    download: options.download,
    document: options.downloadDocument ? async (id, name, messageId) => saveTelegramDocument(options.dataDir, messageId, name, await options.downloadDocument!(id)) : undefined,
    reportFailure,
    async handle(update, started) {
      await app.receive({
        conversationId,
        inputId: String(update.messageId),
        source: "telegram",
        text: update.text ?? (update.runtimeMaterials ? "请查看这个附件。" : "请分析这张图片。"),
        userText: update.text ?? "",
        replyToMessageId: update.replyToMessageId === undefined ? undefined : String(update.replyToMessageId),
        replyToMessage: update.replyToMessage,
        images: update.images,
        runtimeMaterials: update.runtimeMaterials,
        telegram: update.telegram,
      });
      started();
    },
  });
  return {
    ...input,
    sendStartup(text: string, startupId: string) {
      return send("startup", () => bot.api.sendMessage(ownerId, text),
        { conversationId, startupId });
    },
    async close({ waitForIdle = true }: { waitForIdle?: boolean } = {}) {
      await input.finish();
      if (waitForIdle) await app.waitForIdle();
      unsubscribe();
      unsubscribePreviews();
      unregisterInteractions();
      await drafts.close();
    },
  };
}
