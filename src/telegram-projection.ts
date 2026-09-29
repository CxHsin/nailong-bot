import { randomUUID } from "node:crypto";
import type { RuntimeLog, StoredEvent } from "./runtime-log.js";
import { formatMarkdownForTelegram } from "./telegram-format.js";

export type TelegramTransport = {
  send(text: string, chatId: number, parseMode?: "HTML"): Promise<number>;
  edit(messageId: number, text: string, chatId: number, parseMode?: "HTML"): Promise<void>;
  isRejected?: (error: unknown) => boolean;
};

type TextEvent = StoredEvent & { eventId: string; sequence: number; textSegmentId: string; text: string };
type DeliveryEvent = StoredEvent & {
  textSegmentId: string; partIndex: number; attemptId: string;
  snapshotEventId: string; telegramMessageId?: number; text?: string; action?: string;
};

export function splitTelegramText(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const point of text) {
    if (current.length + point.length > 4000) {
      parts.push(current);
      current = "";
    }
    current += point;
  }
  if (current) parts.push(current);
  return parts;
}

export function createTelegramProjection(options: { log: RuntimeLog; chatId: number } & TelegramTransport) {
  async function state(textSegmentId: string) {
    const all = await options.log.read();
    const snapshots = all.filter((event): event is TextEvent =>
      event.type === "text_snapshot" && event.textSegmentId === textSegmentId &&
      typeof event.text === "string" && typeof event.eventId === "string" &&
      typeof event.sequence === "number");
    const final = all.findLast((event) => event.type === "text_finalized" &&
      event.textSegmentId === textSegmentId);
    const deliveries = all.filter((event): event is DeliveryEvent =>
      event.textSegmentId === textSegmentId && event.type.startsWith("telegram_delivery_") &&
      typeof event.partIndex === "number" && typeof event.attemptId === "string" &&
      typeof event.snapshotEventId === "string");
    return { snapshots, final, deliveries };
  }

  return {
    async reconcile(textSegmentId: string): Promise<void> {
      const { snapshots, deliveries } = await state(textSegmentId);
      const snapshot = snapshots.at(-1);
      if (!snapshot) return;
      const parts = splitTelegramText(snapshot.text);
      for (const [partIndex, text] of parts.entries()) {
        const attempts = deliveries.filter((event) => event.partIndex === partIndex &&
          event.type === "telegram_delivery_attempt");
        const successful = deliveries.filter((event) => event.partIndex === partIndex &&
          event.type === "telegram_delivery_succeeded");
        const latestSuccess = successful.at(-1);
        if (latestSuccess?.text === text) continue;
        // A first send without a returned message ID cannot be reconciled safely.
        // Its attempt remains a durable barrier even after a known rejection.
        if (!latestSuccess && attempts.some((event) => event.action === "send")) continue;
        const messageId = latestSuccess?.telegramMessageId;
        const action = messageId === undefined ? "send" : "edit";
        const attemptId = randomUUID();
        const identity = { requestId: snapshot.requestId, textSegmentId, partIndex,
          snapshotEventId: snapshot.eventId, attemptId, chatId: options.chatId };
        await options.log.append({ type: "telegram_delivery_attempt", ...identity, action, text });
        let telegramMessageId: number;
        try {
          const rendered = formatMarkdownForTelegram(text);
          telegramMessageId = action === "send"
            ? await options.send(rendered, options.chatId, "HTML")
            : (await options.edit(messageId!, rendered, options.chatId, "HTML"), messageId!);
        } catch (error) {
          await options.log.append({ type: options.isRejected?.(error) ?
            "telegram_delivery_failed" : "telegram_delivery_unknown", ...identity,
            action, error: String(error), ...(messageId === undefined ? {} : { telegramMessageId: messageId }) });
          continue;
        }
        await options.log.append({ type: "telegram_delivery_succeeded", ...identity,
          action, text, telegramMessageId });
      }
    },
    async finalDelivered(textSegmentId: string): Promise<boolean> {
      const { snapshots, final, deliveries } = await state(textSegmentId);
      if (final?.contentKind !== "final") return false;
      const text = snapshots.at(-1)?.text;
      if (text === undefined || text !== final.text) return false;
      const parts = splitTelegramText(text);
      return parts.length > 0 && parts.every((part, partIndex) =>
        deliveries.findLast((event) => event.partIndex === partIndex &&
          event.type === "telegram_delivery_succeeded")?.text === part);
    },
  };
}
