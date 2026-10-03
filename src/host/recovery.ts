import type { StoredEvent } from "../runtime/runtime-types.js";
import { reduceRunDelivery, type RunDeliveryState } from "../runtime/delivery-pipeline.js";

export type RecoveredRun = { runId: string; conversationId?: string; state: RunDeliveryState["runState"]; resultId?: string; terminal: boolean };
export function recoverRuns(events: StoredEvent[]): RecoveredRun[] {
  const ids = [...new Set(events.map((event) => event.runId).filter((id): id is string => typeof id === "string"))];
  return ids.map((runId) => {
    const own = events.filter((event) => event.runId === runId);
    const succeeded = own.findLast((event) => event.type === "run_succeeded" && event.result && typeof event.result === "object");
    const candidate = succeeded?.result && typeof succeeded.result === "object" ? (succeeded.result as { resultId?: unknown }).resultId : undefined;
    const resultId = typeof candidate === "string" ? candidate : undefined;
    const state = reduceRunDelivery(events, runId, resultId).runState;
    return { runId, conversationId: typeof own[0]?.conversationId === "string" ? own[0].conversationId : undefined, state, resultId, terminal: ["succeeded", "failed", "cancelled"].includes(state) };
  });
}

export function reusableResult(events: StoredEvent[], resultId: string) {
  const event = events.findLast((entry) => entry.type === "run_succeeded" && entry.result && typeof entry.result === "object" &&
    (entry.result as { resultId?: unknown }).resultId === resultId);
  return event?.result && typeof event.result === "object" ? structuredClone(event.result) : undefined;
}
