import type { Message } from "./app.js";
import type { StoredEvent } from "./runtime-log.js";

/** Derived state only: every value can be rebuilt from the committed event prefix. */
export function projectRequestState(events: StoredEvent[]) {
  const open = new Set<string>();
  const failed = new Set<string>();
  const delivered = new Set<string>();
  for (const event of events) {
    const id = event.requestId;
    if (!id) continue;
    if (event.type === "request_started") open.add(id);
    if (["request_completed", "request_failed", "request_interrupted"].includes(event.type)) open.delete(id);
    if (event.type === "request_failed") failed.add(id);
    if (event.type === "delivery_succeeded") delivered.add(id);
  }
  return { open, failed, delivered };
}

/** Compatibility view for simple answer adapters; Pi uses replayEvents instead. */
export function projectDeliveredChat(events: StoredEvent[]): Message[] {
  const reset = events.findLastIndex((event) => event.type === "reset");
  const generated = new Map<string, string>();
  const messages: Message[] = [];
  for (const event of events.slice(reset + 1)) {
    if (event.type === "message" && event.role === "user" && typeof event.text === "string") {
      messages.push({ role: "user", text: event.text,
        ...(Array.isArray(event.images) ? { images: event.images as NonNullable<Message["images"]> } : {}) });
    } else if (event.type === "message" && event.role === "assistant" && !event.requestId &&
      typeof event.text === "string") {
      messages.push({ role: "assistant", text: event.text });
    } else if (event.type === "answer_generated" && event.requestId && typeof event.text === "string") {
      generated.set(event.requestId, event.text);
    } else if (event.type === "delivery_succeeded" && event.requestId) {
      const answer = generated.get(event.requestId);
      if (answer !== undefined) messages.push({ role: "assistant", text: answer });
    }
  }
  return messages;
}

export function projectFinalAnswer(events: StoredEvent[], requestId: string, text: string) {
  return events.findLast((event) => event.type === "text_finalized" &&
    event.requestId === requestId && event.contentKind === "final" && event.text === text &&
    typeof event.textSegmentId === "string");
}

export function projectRecoverableTelegram(events: StoredEvent[]) {
  const segments = [...new Set(events.filter((event) => event.type === "text_snapshot" &&
    typeof event.textSegmentId === "string").map((event) => event.textSegmentId as string))];
  const delivered = projectRequestState(events).delivered;
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
