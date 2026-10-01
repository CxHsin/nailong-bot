import type { StoredEvent } from "../runtime/runtime-types.js";

export function projectRecoverableTelegram(events: StoredEvent[]) {
  const segments = [...new Set(events.filter((event) => event.type === "text_snapshot" &&
    typeof event.textSegmentId === "string").map((event) => event.textSegmentId as string))];
  const delivered = new Set(events.filter((event) => event.type === "delivery_succeeded").map((event) => event.requestId));
  const finals = events.filter((event) => event.type === "text_finalized" &&
    event.contentKind === "final" && typeof event.textSegmentId === "string" &&
    typeof event.requestId === "string" && typeof event.text === "string" &&
    !delivered.has(event.requestId));
  return { segments, finals };
}

export type TextSnapshot = StoredEvent & { eventId: string; sequence: number; textSegmentId: string; text: string };
export type TelegramDelivery = StoredEvent & { textSegmentId: string; partIndex: number;
  attemptId: string; snapshotEventId: string; telegramMessageId?: number; text?: string; action?: string };

export function projectTelegramSegment(events: StoredEvent[], textSegmentId: string) {
  const snapshots = events.filter((event): event is TextSnapshot =>
    event.type === "text_snapshot" && event.textSegmentId === textSegmentId &&
    typeof event.text === "string" && typeof event.eventId === "string" &&
    typeof event.sequence === "number");
  const final = events.findLast((event) => event.type === "text_finalized" &&
    event.textSegmentId === textSegmentId);
  const deliveries = events.filter((event): event is TelegramDelivery =>
    event.textSegmentId === textSegmentId && event.type.startsWith("telegram_delivery_") &&
    typeof event.partIndex === "number" && typeof event.attemptId === "string" &&
    typeof event.snapshotEventId === "string");
  return { snapshots, final, deliveries };
}
