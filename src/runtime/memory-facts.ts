import { sourceDigest } from "./event-digest.js";
import { segmentDelivery } from "./delivery-facts.js";
import type { StoredEvent } from "./runtime-types.js";

export type MemoryMessage = { id: string; role: "user" | "assistant"; text: string; at: string; images?: unknown[] };
export type MemoryNode = { id: string; requestId?: string; userId: number; at: string; messages: MemoryMessage[] };
export function eventIdentity(event: StoredEvent, index: number): string {
  return typeof event.eventId === "string" ? event.eventId : `event:${index}:${sourceDigest(event)}`;
}
export function memoryExclusions(events: StoredEvent[]): Set<string> {
  return new Set(events.filter((e) => e.type === "memory_excluded" && typeof e.nodeId === "string").map((e) => String(e.nodeId)));
}
export function memoryNodes(events: StoredEvent[], userId: number): MemoryNode[] {
  const excluded = memoryExclusions(events);
  const nodes: MemoryNode[] = [];
  let legacy: MemoryNode | undefined;
  for (const [index, event] of events.entries()) {
    if (event.type === "message" && event.role === "user" && typeof event.text === "string") {
      legacy = undefined;
      if (event.chatId !== undefined && event.chatId !== userId || event.text.startsWith("/")) continue;
      const id = event.requestId ?? eventIdentity(event, index);
      if (excluded.has(id)) continue;
      const node: MemoryNode = { id, requestId: event.requestId, userId, at: event.at, messages: [
        { id: eventIdentity(event, index), role: "user", text: event.originalText === null ? "" : typeof event.originalText === "string" ? event.originalText : event.text,
          at: event.at, ...(Array.isArray(event.images) ? { images: event.images.map((image, imageIndex) => ({
            eventId: eventIdentity(event, index), imageIndex, mimeType: (image as { mimeType?: string }).mimeType })) } : {}) },
      ] };
      nodes.push(node); legacy = node;
    } else if (event.type === "message" && event.role === "assistant" && !event.requestId && legacy && typeof event.text === "string") {
      legacy.messages.push({ id: eventIdentity(event, index), role: "assistant", text: event.text, at: event.at });
    }
  }
  for (const node of nodes) {
    if (!node.requestId) continue;
    const request = events.filter((e) => e.requestId === node.requestId);
    const finals = request.filter((e) => e.type === "text_finalized" && ["result", "final"].includes(String(e.contentKind)) && typeof e.text === "string");
    for (const event of finals) {
      const delivery = segmentDelivery(events, event.textSegmentId);
      const hasTransportFacts = request.some((e) => e.type.startsWith("telegram_"));
      const legacyDelivered = (event.protocolVersion !== "json-text-v2" || !hasTransportFacts) && event.contentKind === "final" && request.some((e) =>
        e.type === "delivery_succeeded" && (e.textSegmentId === undefined || e.textSegmentId === event.textSegmentId));
      if (delivery.discarded || !delivery.complete && !legacyDelivered) continue;
      const index = events.indexOf(event);
      node.messages.push({ id: eventIdentity(event, index), role: "assistant", text: String(event.text), at: event.at });
    }
    if (!finals.length && request.some((e) => e.type === "delivery_succeeded")) {
      const answer = request.findLast((e) => e.type === "answer_generated" && typeof e.text === "string");
      if (answer) node.messages.push({ id: eventIdentity(answer, events.indexOf(answer)), role: "assistant", text: String(answer.text), at: answer.at });
    }
  }
  return nodes;
}
