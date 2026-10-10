import type { RuntimeSemanticFact } from "./event-schema.js";
import type { RuntimeLog, StoredEvent } from "./runtime-types.js";

/** Production writes are statically checked; storage keeps its existing validation and transaction rules. */
export function appendRuntimeFact(log: RuntimeLog, fact: RuntimeSemanticFact): Promise<unknown> {
  return log.append(fact);
}

/** Preserve the store's atomic batch when present, and its existing ordered fallback otherwise. */
export async function appendRuntimeFacts(log: RuntimeLog, facts: RuntimeSemanticFact[]): Promise<void> {
  if (log.appendBatch) await log.appendBatch(facts);
  else for (const fact of facts) await log.append(fact);
}

/** Prove only the fields required by consumers; legacy provenance and extra fields remain untouched. */
export function settledTextFact(event: StoredEvent): (StoredEvent & {
  type: "text_finalized"; requestId: string; textSegmentId: string; text: string;
}) | undefined {
  return isSettledText(event) ? event : undefined;
}
function isSettledText(event: StoredEvent): event is StoredEvent & {
  type: "text_finalized"; requestId: string; textSegmentId: string; text: string;
} {
  return event.type === "text_finalized" && typeof event.requestId === "string" &&
    typeof event.textSegmentId === "string" && typeof event.text === "string";
}

export function runResultFact(event: StoredEvent): (StoredEvent & {
  type: "run_succeeded"; result: Record<string, unknown>;
}) | undefined {
  return isRunResult(event) ? event : undefined;
}
function isRunResult(event: StoredEvent): event is StoredEvent & {
  type: "run_succeeded"; result: Record<string, unknown>;
} {
  return event.type === "run_succeeded" && !!event.result && typeof event.result === "object";
}

/** Ownership interpretation shared by independent views, without consulting any Projection. */
export function factOwnerId(event: StoredEvent): string | undefined {
  return event.requestId ?? (typeof event.runId === "string" ? event.runId : undefined);
}
