import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { StoredEvent } from "../runtime/runtime-types.js";
import { errorCategories, providerErrorCategory, safeProviderRequestId, transportCauses } from "../runtime/transport-diagnostics.js";

const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const label = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
const stopReasons = new Set(["stop", "length", "toolUse", "error", "aborted"]);

/** Read only the requested Run; allowlisted projections never include conversation or tool content. */
export function diagnoseRun(options: { dataDir: string; runId: string }) {
  if (!options.runId.trim()) throw new Error("需要 Run ID");
  const db = new DatabaseSync(join(options.dataDir, "runtime-v2.sqlite"), { readOnly: true });
  let events: StoredEvent[];
  try {
    events = db.prepare("SELECT payload FROM runtime_events WHERE request_id = ? OR (request_id IS NULL AND json_extract(payload, '$.runId') = ?) ORDER BY sequence")
      .all(options.runId, options.runId).map((row) => JSON.parse(String(row.payload)) as StoredEvent);
  } finally { db.close(); }
  if (!events.length) throw new Error("Run 不存在");
  const terminal = events.findLast((e) => ["run_succeeded", "run_failed", "run_cancelled", "request_completed", "request_failed", "request_interrupted"].includes(e.type));
  const state = terminal ? ({ run_succeeded: "succeeded", run_failed: "failed", run_cancelled: "cancelled", request_completed: "succeeded", request_failed: "failed", request_interrupted: "cancelled" }[terminal.type] ?? "unknown") : "unfinished";
  const projected = events.findLast((e) => e.type === "context_projected");
  const estimatedTokens = finite(projected?.estimatedTokens); const budget = finite(projected?.budget);
  const modelSteps = events.filter((e) => e.type === "model_step_started" || e.type === "model_call_started").map((started) => {
    const id = started.modelStepId ?? started.callId;
    const message = events.findLast((e) => e.type === "model_message" && e.modelStepId === id)?.message as { stopReason?: unknown; errorMessage?: unknown } | undefined;
    const transport = events.findLast((e) => e.type === "model_transport" && e.callId === id);
    const causes = Array.isArray(transport?.causes) ? transport.causes.flatMap(transportCauses).slice(0, 4) : [];
    const reason = transport?.stopReason ?? message?.stopReason;
    return { callId: label(id), purpose: label(started.purpose), step: finite(started.step), model: label(started.model), provider: label(started.provider),
      stopReason: typeof reason === "string" && stopReasons.has(reason) ? reason : null,
      httpStatus: finite(transport?.httpStatus), providerRequestId: safeProviderRequestId(transport?.providerRequestId), elapsedMs: finite(transport?.elapsedMs),
      errorCategory: typeof transport?.errorCategory === "string" && errorCategories.has(transport.errorCategory) ? transport.errorCategory : providerErrorCategory(reason, message?.errorMessage, causes), causes };
  });
  const mode = events.find((e) => e.type === "capability_snapshot")?.mode;
  const tools = events.filter((e) => e.type === "tool_result");
  return { runId: options.runId, state, sourceEvents: events.length, mode: mode === "compat" || mode === "native" ? mode : null,
    context: { estimatedTokens, budget, exceedsBudget: estimatedTokens !== null && budget !== null ? estimatedTokens > budget : null },
    tools: { results: tools.length, errors: tools.filter((e) => e.isError === true || (e.result as { isError?: boolean } | undefined)?.isError === true).length },
    modelSteps, evidenceLimit: "Recorded facts only; absent HTTP/cause fields cannot identify the failing network hop." };
}
