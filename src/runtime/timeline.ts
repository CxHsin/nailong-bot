import type { StoredEvent } from "./runtime-types.js";
import { segmentDelivery } from "./delivery-facts.js";
import { settledTextFact } from "./facts.js";

export type TimelineText = { id: string; runId: string; text: string; kind: "progress" | "result" | "final"; source: "execution" | "progress-model";
  eventId?: string; sequence?: number; delivered: boolean };

/** Both history views and live delivery select content from committed settlement facts. */
export function projectTimeline(events: StoredEvent[]): TimelineText[] {
  const discarded = new Set(events.filter((event) => event.type === "text_discarded").map((event) => event.textSegmentId));
  return events.flatMap((raw): TimelineText[] => {
    const event = settledTextFact(raw);
    if (!event || discarded.has(event.textSegmentId)) return [];
    if (["status", "progress"].includes(String(event.contentKind)) && event.protocolVersion !== "plain-text-v3" && event.contextPolicy !== "include") return [];
    const kind = event.contentKind === "final" ? "final" : event.contentKind === "result" ? "result" : "progress";
    return [{ id: event.textSegmentId, runId: event.requestId, text: event.text, kind,
      source: event.source === "progress-model" ? "progress-model" : "execution",
      ...(typeof event.eventId === "string" ? { eventId: event.eventId } : {}),
      ...(typeof event.sequence === "number" ? { sequence: event.sequence } : {}),
      delivered: segmentDelivery(events, event.textSegmentId).complete }];
  });
}
