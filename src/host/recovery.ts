import type { StoredEvent } from "../runtime/runtime-types.js";
import { reduceRunDelivery, type RunDeliveryState } from "../runtime/delivery-pipeline.js";
import { runResultFact } from "../runtime/facts.js";

export type RecoveredRun = { runId: string; conversationId?: string; state: RunDeliveryState["runState"]; resultId?: string; terminal: boolean };
export function recoverRuns(events: StoredEvent[]): RecoveredRun[] {
  const ids = [...new Set(events.map((event) => event.runId).filter((id): id is string => typeof id === "string"))];
  return ids.map((runId) => {
    const own = events.filter((event) => event.runId === runId);
    const succeeded = own.map(runResultFact).findLast((event) => event !== undefined);
    const candidate = succeeded?.result.resultId;
    const resultId = typeof candidate === "string" ? candidate : undefined;
    const state = reduceRunDelivery(events, runId, resultId).runState;
    return { runId, conversationId: typeof own[0]?.conversationId === "string" ? own[0].conversationId : undefined, state, resultId, terminal: ["succeeded", "failed", "cancelled"].includes(state) };
  });
}

export function reusableResult(events: StoredEvent[], resultId: string) {
  const event = events.map(runResultFact).findLast((entry) => entry?.result.resultId === resultId);
  return event ? structuredClone(event.result) : undefined;
}
