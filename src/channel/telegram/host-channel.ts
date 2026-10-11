import { InputFile, type Bot } from "grammy";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createNailongStickerPicker } from "./nailong-stickers.js";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { TelegramChannelHost } from "../../application/channel-contract.js";
import { AGENT_COMMANDS } from "../../application/commands.js";
import { createTelegramHostProjection, normalizeTelegramInput, type TelegramHostTransport } from "./index.js";
import { registerTelegramInput } from "../../telegram/telegram-input.js";
import type { HostEvent } from "../../host/host.js";

/** Startup and input boundary shared by production and Channel acceptance tests. */
export async function initializeTelegramHostChannel(options: { bot: Bot; ownerId: number; host: TelegramChannelHost;
  transport: TelegramHostTransport; download: (fileId: string) => Promise<ImageContent>;
  reportFailure: (error?: unknown) => void; onDelivered?: (event: HostEvent, messageId: number) => Promise<void> }) {
  const { bot, ownerId } = options;
  await bot.init();
  try {
    await bot.api.setMyCommands(AGENT_COMMANDS.map(({ command, description }) => ({ command, description })),
      { scope: { type: "chat", chat_id: ownerId } });
    await bot.api.setChatMenuButton({ chat_id: ownerId, menu_button: { type: "commands" } });
  } catch (error) {
    options.reportFailure(new Error("Telegram 命令菜单同步失败；聊天继续启动，下次启动将重试。", { cause: error }));
  }
  const pickSticker = createNailongStickerPicker();
  await options.host.notifyRecovery("telegram", async (text) => { await options.transport.send(text, ownerId); });
  const projection = createTelegramHostProjection({ ...options.transport,
    recordProgress: (event, fact) => options.host.recordProgress(event, fact),
    sendSticker: options.transport.sendSticker ?? (async (category, chatId) =>
      (await bot.api.sendSticker(chatId, pickSticker(category))).message_id),
    sendAnimation: options.transport.sendAnimation ?? (async (animation, caption, chatId) => {
      if (animation !== "nailong-dance") throw new Error("未知动画");
      const sourcePath = fileURLToPath(new URL("../../../assets/nailong-dance.gif", import.meta.url));
      const path = existsSync(sourcePath) ? sourcePath : fileURLToPath(new URL("../../../../assets/nailong-dance.gif", import.meta.url));
      return (await bot.api.sendAnimation(chatId, new InputFile(path), { caption })).message_id;
    }), chatId: ownerId, onDelivered: options.onDelivered,
    deliver: (event, content, signal) => options.host.deliverContent(event, content, options.transport, signal) });
  const input = registerTelegramInput(bot, { ownerId, botUsername: bot.botInfo.username, download: options.download, reportFailure: options.reportFailure,
    handle: async (update, started) => {
      const image = update.images?.[0];
      const normalized = normalizeTelegramInput({ fromId: update.userId, chatId: update.userId, chatType: update.chatType,
        messageId: update.messageId, replyToMessageId: update.replyToMessageId, text: update.text, image });
      const run = options.host.submit(normalized);
      started();
      await projection.consume(run);
    } });
  bot.catch((error) => options.reportFailure(error));
  return { ...input, async start() {
    try { await bot.start({ limit: 1, drop_pending_updates: false }); }
    finally { await input.finish(); }
  }, async stop() { await input.accepted(); await bot.stop(); } };
}
