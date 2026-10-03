import type { StoredEvent } from "../runtime/runtime-types.js";

export const HOST_EVENT_SCHEMA_VERSION = 1 as const;
export type HostEventEnvelope = StoredEvent & {
  schemaVersion: number;
  runId?: string;
  conversationId?: string;
  sequence?: number;
};

/** Read compatibility is intentionally additive: legacy payloads remain untouched on disk. */
export function upcastHostEvent(event: StoredEvent): HostEventEnvelope {
  const schemaVersion = typeof event.schemaVersion === "number" && event.schemaVersion > 0
    ? event.schemaVersion : HOST_EVENT_SCHEMA_VERSION;
  return { ...event, schemaVersion };
}

export function isHostEvent(event: StoredEvent): event is HostEventEnvelope & { runId: string; sequence: number } {
  return typeof event.runId === "string" && typeof event.sequence === "number";
}
