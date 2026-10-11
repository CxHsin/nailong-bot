import type { Message } from "./app-types.js";
import type { StoredEvent } from "../runtime/runtime-types.js";
import { filterMemoryEvents } from "../runtime/memory-exclusion.js";
import { memoryExclusions } from "../runtime/memory-facts.js";
import { userInputText } from "../runtime/reply-context.js";

/** Compatibility view for simple answer adapters; Pi uses replayEvents instead. */
export function projectDeliveredChat(events: StoredEvent[]): Message[] {
  const excluded = memoryExclusions(events);
  events = filterMemoryEvents(events);
  const reset = events.findLastIndex((event) => event.type === "reset" || event.type === "conversation_reset");
  const generated = new Map<string, string>();
  const messages: Message[] = [];
  for (const event of events.slice(reset + 1)) {
    if (event.type === "message" && event.role === "user" && typeof event.text === "string") {
      messages.push({ role: "user", text: userInputText(event, excluded),
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
