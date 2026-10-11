import { eventIdentity, memoryExclusions } from "./memory-facts.js";
import { filterMemoryEvents } from "./memory-exclusion.js";
import { sourceDigest } from "./event-digest.js";
import type { StoredEvent } from "./runtime-types.js";

export type ActiveContextStart = { type: "active_context_started"; version: 1; activeContextId: string;
  resetIdentity: string; initialRequestIds: string[]; sourceThrough: number; sourceDigest: string;
  migration: "new" | "legacy-reconstruction" | "legacy-snapshot"; legacyBoundary?: string };
export type LegacyContextScope = { requestIds: string[]; boundary: string };

export function resetIdentity(events: StoredEvent[]): string {
  const index = events.findLastIndex((event) => ["reset", "conversation_reset"].includes(event.type));
  return index < 0 ? "initial" : eventIdentity(events[index]!, index);
}

/** Interpret the committed start against original facts, never against a derived snapshot. */
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

/** Identity is provided by the caller, which decides when to commit. */
export function pendingActiveContext(raw: StoredEvent[], currentId: string, identity: string,
  legacy?: LegacyContextScope): ActiveContextStart | undefined {
  if (!raw.some((event) => event.requestId === currentId && typeof event.conversationId === "string") || activeContextStart(raw)) return;
  const reset = raw.findLastIndex((event) => ["reset", "conversation_reset"].includes(event.type));
  const previous = raw.flatMap((event, index) => index > reset && event.type === "message" && event.role === "user" && event.requestId !== currentId
    ? [event.requestId ?? `legacy:${eventIdentity(event, index)}`] : []);
  const initialRequestIds = legacy?.requestIds ?? [...new Set(previous)].slice(-4);
  return { type: "active_context_started", version: 1, activeContextId: identity,
    resetIdentity: resetIdentity(raw), initialRequestIds: [...new Set([...initialRequestIds, currentId])],
    sourceThrough: raw.length, sourceDigest: sourceDigest(raw),
    migration: legacy ? "legacy-snapshot" : previous.length ? "legacy-reconstruction" : "new",
    ...(legacy ? { legacyBoundary: legacy.boundary } : {}) };
}

export function activeRequestIds(raw: StoredEvent[], start: StoredEvent & ActiveContextStart): Set<string> {
  const ids = new Set(start.initialRequestIds);
  for (let index = start.sourceThrough; index < raw.length; index++) {
    const event = raw[index]!;
    if (event.type === "message" && event.role === "user") ids.add(event.requestId ?? `legacy:${eventIdentity(event, index)}`);
  }
  return ids;
}

export type HistoryScope = ReturnType<typeof historyScope>;
export function historyScope(raw: StoredEvent[], currentId: string, pending?: ActiveContextStart) {
  const excluded = memoryExclusions(raw);
  const all = filterMemoryEvents(raw);
  const reset = all.findLastIndex((event) => ["reset", "conversation_reset"].includes(event.type));
  const events = all.slice(reset + 1);
  const active = activeContextStart(raw) ?? (pending ? { ...pending, at: "" } : undefined);
  const ownerOfUser = (event: StoredEvent, index: number) => event.requestId ??
    (active ? `legacy:${eventIdentity(event, all.indexOf(event))}` : `legacy:${index}`);
  const turnIds = events.flatMap((event, index) => event.type === "message" && event.role === "user" ? [ownerOfUser(event, index)] : []);
  const recent = [...new Set(turnIds.filter((id) => id !== currentId))].slice(-3);
  const selected = active ? activeRequestIds(raw, active) : new Set([...recent, currentId]);
  const host = raw.some((event) => event.requestId === currentId && typeof event.conversationId === "string");
  return { raw, all, events, reset, active, recent, selected, excluded, host, ownerOfUser };
}
