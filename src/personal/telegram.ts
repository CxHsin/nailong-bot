import { InputFile, type Bot } from 'grammy';
import type { ImageContent } from '@mariozechner/pi-ai';
import { registerTelegramInput } from '../telegram/telegram-input.js';
import { createPlainChannel, parseInputControl } from './channels.js';
import type { PersonalHost } from './host.js';
import type { Delivery } from './types.js';
import { richReplyPages, textOnlyMarkdown } from '../telegram/rich-reply.js';
import { createDraftPreview } from '../telegram/draft-preview.js';

/** Telegram authenticates and delivers; it owns no Agent execution or progress loop. */
export function createPersonalTelegram(options: { bot: Bot; ownerId: number; host: PersonalHost;
  download: (fileId: string) => Promise<ImageContent>;
  onDelivered?: (delivery: Delivery) => Promise<void>; reportFailure: (error: unknown) => void }) {
  const { bot, ownerId, host } = options;
  const conversationId = `telegram:private:${ownerId}`;
  const formatFailure = (error: unknown) => { const failure = error as { error_code?: number; description?: string }; return failure.error_code === 400 && /pars|format|rich|block|entit/i.test(failure.description ?? ''); };
  const drafts = createDraftPreview({ reportFailure: options.reportFailure,
    send: async (id, text) => {
      const page = richReplyPages(text).at(-1);
      if (!page?.text.trim()) return;
      const plain = { blocks: [{ type: 'paragraph' as const, text: page.text }] };
      try { await bot.api.sendRichMessageDraft(ownerId, id, page.textFormat === 'plain' ? plain : { markdown: textOnlyMarkdown(page.text) }); }
      catch (error) { if (page.textFormat === 'plain' || !formatFailure(error)) throw error; await bot.api.sendRichMessageDraft(ownerId, id, plain); }
    } });
  const unsubscribePreview = host.subscribePreviews(preview => { if (preview.conversationId === conversationId) drafts.update(preview); });
  const channel = createPlainChannel({ host, accepts: id => id === conversationId,
    textPages: richReplyPages,
    sendText: (text, delivery) => drafts.withoutDrafts(async () => {
      const plain = { blocks: [{ type: 'paragraph' as const, text }] };
      try { return String((await bot.api.sendRichMessage(ownerId, delivery.textFormat === 'plain' ? plain : { markdown: textOnlyMarkdown(text) })).message_id); }
      catch (error) {
        // Only a definite format rejection permits a second send. Timeouts remain unknown.
        if (delivery.textFormat === 'plain' || !formatFailure(error)) throw error;
        return String((await bot.api.sendRichMessage(ownerId, plain)).message_id);
      }
    }),
    sendFile: path => drafts.withoutDrafts(async () => String((await bot.api.sendDocument(ownerId, new InputFile(path))).message_id)),
    onDelivered: options.onDelivered, reportFailure: options.reportFailure });
  const input = registerTelegramInput(bot, { ownerId, download: options.download, reportFailure: options.reportFailure,
    handle: async (update, started) => {
      const control = parseInputControl(update.text ?? '请分析这张图片。');
      const pending = channel.receive({ conversationId, actorId: `telegram:${update.userId}`, inputId: String(update.messageId),
        ...control, images: update.images,
        replyTaskId: control.replyTaskId ?? (update.replyToMessageId === undefined ? undefined : host.resolveReply(conversationId, String(update.replyToMessageId))) });
      started();
      await pending;
    } });
  return { ...channel, accepted: input.accepted, finish: input.finish,
    async close() { unsubscribePreview(); await drafts.close(); await channel.close(); } };
}
