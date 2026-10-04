import type { Actor, HostInput } from "../../host/host.js";
import type { ContentPart } from "../../host/content-parts.js";
import { normalizeHostInput } from "../../host/host.js";
export { createTelegramRichTransport, isRichApiUnavailable } from "./rich-transport.js";
export type { TelegramRichTransportApi } from "./rich-transport.js";
export { createTelegramHostProjection } from "./projection.js";
export type { TelegramHostTransport } from "./projection.js";

export type TelegramInput = { fromId: number; chatId: number; chatType: string; messageId: number; replyToMessageId?: number; text?: string; image?: { mimeType: string; data: string; contentRef?: string } };
export function telegramConversationId(chatId: number): string {
  if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error("Telegram chatId 无效");
  return `telegram:private:${chatId}`;
}
export function normalizeTelegramInput(update: TelegramInput): HostInput {
  if (update.chatType !== "private") throw new Error("Telegram Channel 只接受 private chat");
  if (update.fromId !== update.chatId) throw new Error("Telegram Actor 与 private conversation 不匹配");
  const parts: ContentPart[] = [];
  if (update.text !== undefined && update.text.trim()) parts.push({ type: "text", text: update.text });
  if (update.image) parts.push({ type: "image", mimeType: update.image.mimeType, data: update.image.data, ...(update.image.contentRef ? { contentRef: update.image.contentRef } : {}) });
  return normalizeHostInput({ actor: { id: `telegram:${update.fromId}`, kind: "user" }, conversationId: telegramConversationId(update.chatId), parts, metadata: { channel: "telegram", messageId: update.messageId,
    ...(update.replyToMessageId !== undefined ? { replyToMessageId: update.replyToMessageId } : {}) } });
}

export function telegramEnvironment(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): { token: string; ownerId: number } {
  const token = env.AGENT_TELEGRAM_BOT_TOKEN?.trim() || env.TELEGRAM_BOT_TOKEN?.trim();
  const owner = env.AGENT_TELEGRAM_USER_ID?.trim() || env.TELEGRAM_USER_ID?.trim();
  if (!token) throw new Error("缺少 Telegram bot token");
  const ownerId = Number(owner);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error("Telegram ownerId 必须是正整数");
  if (!env.AGENT_TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN) warn("TELEGRAM_* 环境变量已兼容；迁移到 AGENT_TELEGRAM_*。");
  return { token, ownerId };
}

export type TelegramActor = Actor;
