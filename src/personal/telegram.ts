import { InputFile, type Bot } from 'grammy';
import type { ImageContent } from '@mariozechner/pi-ai';
import { registerTelegramInput } from '../telegram/telegram-input.js';
import { createPlainChannel } from './channels.js';
import type { PersonalHost } from './host.js';
import type { Delivery } from './types.js';

/** Telegram authenticates and delivers; it owns no Agent execution or progress loop. */
export function createPersonalTelegram(options: { bot: Bot; ownerId: number; host: PersonalHost;
  download: (fileId: string) => Promise<ImageContent>;
  onDelivered?: (delivery: Delivery) => Promise<void>; reportFailure: (error: unknown) => void }) {
  const { bot, ownerId, host } = options;
  const conversationId = `telegram:private:${ownerId}`;
  const channel = createPlainChannel({ host, accepts: id => id === conversationId,
    sendText: async text => String((await bot.api.sendMessage(ownerId, text)).message_id),
    sendFile: async path => String((await bot.api.sendDocument(ownerId, new InputFile(path))).message_id),
    onDelivered: options.onDelivered, reportFailure: options.reportFailure });
  const input = registerTelegramInput(bot, { ownerId, download: options.download, reportFailure: options.reportFailure,
    handle: async (update, started) => {
      const pending = channel.receive({ conversationId, actorId: `telegram:${update.userId}`, inputId: String(update.messageId),
        text: update.text ?? '请分析这张图片。', images: update.images,
        replyTaskId: update.replyToMessageId === undefined ? undefined : host.resolveReply(conversationId, String(update.replyToMessageId)) });
      started();
      await pending;
    } });
  return { ...channel, accepted: input.accepted, finish: input.finish };
}
