import { randomUUID } from "node:crypto";
import { eventIdentity } from "../runtime/memory-facts.js";
import { sourceDigest } from "../runtime/event-digest.js";
import type { RuntimeLog, StoredEvent } from "../runtime/runtime-types.js";

export type ActiveContextStart = { type: "active_context_started"; version: 1; activeContextId: string;
  resetIdentity: string; initialRequestIds: string[]; sourceThrough: number; sourceDigest: string;
  migration: "new" | "legacy-reconstruction" | "legacy-snapshot"; legacyBoundary?: string };

export function resetIdentity(events: StoredEvent[]): string {
  const index = events.findLastIndex((event) => ["reset", "conversation_reset"].includes(event.type));
  return index < 0 ? "initial" : eventIdentity(events[index]!, index);
}
export function activeContextStart(events: StoredEvent[]): (StoredEvent & ActiveContextStart) | undefined {
  const reset = resetIdentity(events);
  const fact = events.findLast((event) => event.type === "active_context_started" && event.resetIdentity === reset);
  if (!fact) return undefined;
  if (fact.version !== 1 || typeof fact.activeContextId !== "string" || !Array.isArray(fact.initialRequestIds) ||
    fact.initialRequestIds.some((id) => typeof id !== "string") || !Number.isInteger(fact.sourceThrough) ||
    Number(fact.sourceThrough) < 0 || Number(fact.sourceThrough) > events.length ||
    sourceDigest(events.slice(0, Number(fact.sourceThrough))) !== fact.sourceDigest)
    throw new Error("活动上下文起点损坏，无法安全恢复；不会重新迁移历史");
  return fact as StoredEvent & ActiveContextStart;
}
export async function prepareActiveContext(log: RuntimeLog, currentId: string,
  legacy?: { requestIds: string[]; boundary: string }): Promise<{ raw: StoredEvent[]; pending?: ActiveContextStart }> {
  const raw = await log.read();
  if (!raw.some((event) => event.requestId === currentId && typeof event.conversationId === "string") || activeContextStart(raw)) return { raw };
  const reset = raw.findLastIndex((event) => ["reset", "conversation_reset"].includes(event.type));
  const previous = raw.flatMap((event, index) => index > reset && event.type === "message" && event.role === "user" && event.requestId !== currentId
    ? [event.requestId ?? `legacy:${eventIdentity(event, index)}`] : []);
  // The previous Run's last input had three prior turns plus itself. Its settled
  // answer is recovered from the same original facts, even after its last snapshot.
  const initialRequestIds = legacy?.requestIds ?? [...new Set(previous)].slice(-4);
  const value: ActiveContextStart = { type: "active_context_started", version: 1, activeContextId: randomUUID(),
    resetIdentity: resetIdentity(raw), initialRequestIds: [...new Set([...initialRequestIds, currentId])],
    sourceThrough: raw.length, sourceDigest: sourceDigest(raw),
    migration: legacy ? "legacy-snapshot" : previous.length ? "legacy-reconstruction" : "new",
    ...(legacy ? { legacyBoundary: legacy.boundary } : {}) };
  return { raw, pending: value };
}

export function activeRequestIds(raw: StoredEvent[], start: StoredEvent & ActiveContextStart): Set<string> {
  const ids = new Set(start.initialRequestIds);
  for (let index = start.sourceThrough; index < raw.length; index++) {
    const event = raw[index]!;
    if (event.type === "message" && event.role === "user") ids.add(event.requestId ?? `legacy:${eventIdentity(event, index)}`);
  }
  return ids;
}
