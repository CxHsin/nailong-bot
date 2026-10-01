import type { StoredEvent } from "./runtime-types.js";

/** Pure queries over committed facts; no projection state or transport dependencies. */
export function segmentDelivery(events: StoredEvent[], segmentId: unknown) {
  const segment = events.filter((event) => event.textSegmentId === segmentId);
  const final = segment.findLast((event) => event.type === "text_finalized");
  const pages = segment.filter((event) => event.type === "telegram_page");
  const plan = segment.findLast((event) => event.type === "telegram_plan_finalized");
  const discarded = segment.some((event) => event.type === "text_discarded");
  const complete = !!plan && plan.parts === pages.length && pages.length > 0 && pages.every((page) =>
    segment.some((event) => event.type === "telegram_delivery_succeeded" && event.partIndex === page.partIndex));
  return { final, discarded, complete };
}

export function requestDelivered(events: StoredEvent[], requestId: string): boolean {
  const finals = events.filter((event) => event.type === "text_finalized" && event.requestId === requestId &&
    event.protocolVersion === "json-text-v2" && ["result", "final"].includes(String(event.contentKind)));
  if (!finals.length && !events.some((event) => event.type === "text_snapshot" && event.requestId === requestId &&
    event.protocolVersion === "json-text-v2" && event.contentKind !== "notice")) return true;
  if (!finals.some((event) => event.contentKind === "final")) return false;
  return finals.every((final) => {
    const delivery = segmentDelivery(events, final.textSegmentId);
    return !delivery.discarded && delivery.complete;
  });
}

export function finalDelivered(events: StoredEvent[], segmentId: string): boolean {
  const delivery = segmentDelivery(events, segmentId);
  return delivery.final?.contentKind === "final" && delivery.complete;
}
