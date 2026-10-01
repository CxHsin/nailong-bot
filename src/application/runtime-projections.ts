import type { Message } from "./app-types.js";
import type { StoredEvent } from "../runtime/runtime-types.js";

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
