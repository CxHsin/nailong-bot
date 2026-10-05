import type { RuntimeLog } from "./runtime-types.js";

/** Startup records facts only. It never executes a model, tool or transport. */
export async function recordInterruptedRuns(log: RuntimeLog): Promise<number> {
  const events = await log.read();
  const started = events.filter((event) => ["run_submitted", "run_started", "request_started"].includes(event.type));
  const ids = [...new Set(started.map((event) => String(event.runId ?? event.requestId)))];
  let count = 0;
  for (const id of ids) {
    const own = events.filter((event) => event.runId === id || event.requestId === id);
    if (own.some((event) => ["run_succeeded", "run_failed", "run_cancelled", "request_completed", "request_failed", "request_interrupted"].includes(event.type))) continue;
    const identity = { runId: id, requestId: id, conversationId: own.find((event) => typeof event.conversationId === "string")?.conversationId };
    const facts = [{ type: "request_interrupted", ...identity, reason: "process_restart" }, { type: "run_cancelled", ...identity, reason: "process_restart" }];
    if (log.appendBatch) await log.appendBatch(facts); else for (const event of facts) await log.append(event);
    count++;
  }
  return count;
}
