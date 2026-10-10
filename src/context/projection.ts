import type { Api, Message, Model } from "@mariozechner/pi-ai";
import type { RuntimeLog, StoredEvent } from "../runtime/runtime-types.js";
import { sourceDigest } from "../runtime/event-digest.js";
import { filterMemoryEvents } from "../runtime/memory-exclusion.js";
import { historyScope } from "../runtime/history-scope.js";
import { encodeHistory, type EncodedHistoryUnit } from "../agent/history-codec.js";
import { prepareActiveContext } from "./active-context.js";

export type ReplayUnit = EncodedHistoryUnit;
export type Replay = { events: StoredEvent[]; boundary: string; units: ReplayUnit[]; current: Message;
  diagnostics: string[]; processedEvents?: number };

/** Online Projection coordinates durable start and disposable incremental state around shared fact encoding. */
export async function replayEvents(log: RuntimeLog, currentId: string, model: Model<Api>, structured = false,
  onProgress?: (checked: number, total: number) => void, signal?: AbortSignal, seed?: { replay: Replay; start: number },
  legacy?: { requestIds: string[]; boundary: string }): Promise<Replay> {
  const prepared = await prepareActiveContext(log, currentId, legacy);
  const scope = historyScope(prepared.raw, currentId, prepared.pending);
  const { all, selected, excluded, reset, active, recent } = scope;
  let events = scope.events;
  const units = seed ? structuredClone(seed.replay.units.filter((unit) => selected.has(unit.requestId ?? "") &&
    unit.through <= seed.start && !(unit.summaryMessages?.length === 0 && unit.requestId !== currentId))) : [];
  const affectedIds = new Set(events.slice(seed?.start ?? 0).map((event) => event.requestId ?? event.runId).filter((id): id is string => typeof id === "string"));
  const diagnostics = seed ? seed.replay.diagnostics.filter((item) => !item.startsWith("unmatched_tool_") &&
    (!item.startsWith("outcome_unknown:") || [...selected].some((id) => item.startsWith(`outcome_unknown:${id}:`))) &&
    ![...affectedIds].some((id) => item.startsWith(`outcome_unknown:${id}:`))) : [];
  const encoded = await encodeHistory(scope, currentId, model, structured, log, { start: seed?.start, signal, onProgress });
  units.push(...encoded.units);
  diagnostics.push(...encoded.diagnostics);
  if (prepared.pending) {
    if (signal?.aborted) throw new DOMException("历史恢复已取消", "AbortError");
    await log.append(prepared.pending);
    // A failed archive reconstruction cannot commit a migration start.
    const committed = filterMemoryEvents(await log.read());
    const committedReset = committed.findLastIndex((event) => ["reset", "conversation_reset"].includes(event.type));
    events = committed.slice(committedReset + 1);
  }
  const boundary = active ? `active-v1:${active.activeContextId}` :
    `${reset < 0 ? "initial" : sourceDigest(all.slice(0, reset + 1))}:recent-three-v1:${sourceDigest(recent)}`;
  return { events, boundary: excluded.size ? `${boundary}:${sourceDigest([...excluded].sort())}` : boundary,
    units, current: encoded.current, diagnostics, processedEvents: events.length - (seed?.start ?? 0) };
}
