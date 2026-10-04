import { createHash } from "node:crypto";
import { eventIdentity } from "./memory-facts.js";
import type { RuntimeLog, StoredEvent } from "./runtime-types.js";

/** Legacy ownership is admitted only when a durable identity supports it. */
export function conversationOwnership(events: StoredEvent[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const event of events) {
    const id = event.requestId ?? (typeof event.runId === "string" ? event.runId : undefined);
    const conversation = typeof event.conversationId === "string" ? event.conversationId :
      typeof event.chatId === "number" ? `telegram:private:${event.chatId}` : undefined;
    if (id && conversation) owners.set(id, conversation);
  }
  return owners;
}

export function conversationEvents(events: StoredEvent[], conversationId: string): StoredEvent[] {
  const owners = conversationOwnership(events);
  const ownerId = conversationUserId(conversationId);
  return events.flatMap((event, index) => {
    const previous = events[index - 1];
    // The old command adapter wrote these adjacent records as one batch.
    const legacyResetOwner = event.type === "reset" && previous?.type === "message" &&
      previous.role === "user" && previous.text === "/reset" && !previous.requestId && !previous.images
      ? typeof previous.conversationId === "string" ? previous.conversationId :
        typeof previous.chatId === "number" ? `telegram:private:${previous.chatId}` : undefined
      : undefined;
    const id = event.requestId ?? (typeof event.runId === "string" ? event.runId : undefined);
    const owner = typeof event.conversationId === "string" ? event.conversationId : id ? owners.get(id) :
      typeof event.nodeId === "string" ? owners.get(event.nodeId) :
      typeof event.chatId === "number" ? `telegram:private:${event.chatId}` :
      event.userId === ownerId && conversationId.startsWith("telegram:private:") ? conversationId : legacyResetOwner;
    return owner === conversationId ? [{ ...event, eventId: eventIdentity(event, index) }] : [];
  });
}

export function conversationUserId(conversationId: string): number {
  const match = /^telegram:private:(\d+)$/.exec(conversationId);
  return match ? Number(match[1]) : Number.parseInt(createHash("sha256").update(conversationId).digest("hex").slice(0, 12), 16);
}

export function conversationLog(log: RuntimeLog, conversationId: string): RuntimeLog {
  const decorate = (event: Omit<StoredEvent, "at">) => ({ ...event, conversationId });
  return { ...log, read: async () => conversationEvents(await log.read(), conversationId),
    append: (event) => log.append(decorate(event)),
    ...(log.appendBatch ? { appendBatch: (events: Array<Omit<StoredEvent, "at">>) => log.appendBatch!(events.map(decorate)) } : {}),
    ...(log.readSince ? { readSince: async (sequence: number) => conversationEvents(await log.readSince!(sequence), conversationId) } : {}) };
}
