import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModel } from "@mariozechner/pi-ai";
import { createRuntimeLog } from "../runtime/runtime-log.js";
import { createToolArchive } from "../runtime/tool-archive.js";
import { conversationEvents } from "../runtime/conversation-log.js";
import type { StoredEvent } from "../runtime/runtime-types.js";
import { replayEvents } from "../context/projection.js";
import { createContextProjection } from "../context/context-budget.js";
import { estimateInput, modelInputBudget } from "../context/input-budget.js";
import { sourceDigest } from "../runtime/event-digest.js";
import { createReplayCache } from "../context/replay-cache.js";

const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const identifier = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
const failureReasons = new Set(["same_input_failed", "no_safe_history", "summary_input_too_large", "candidate_rejected"]);
const reason = (value: unknown) => typeof value === "string" && failureReasons.has(value) ? value : null;

function recordedEvidence(events: StoredEvent[], requestId: string) {
  const own = events.filter((event) => event.requestId === requestId);
  const projected = own.findLast((event) => event.type === "context_projected");
  const activeEvents = events.slice(events.findLastIndex((event) => ["reset", "conversation_reset"].includes(event.type)) + 1);
  const active = activeEvents.findLast((event) => event.type === "active_context_started");
  const committed = activeEvents.findLast((event) => event.type === "context_checkpoint_committed");
  const checkpoint = committed?.checkpoint as Record<string, unknown> | undefined;
  const coverage = projected?.coverage as Record<string, unknown> | undefined;
  return {
    activeContext: { id: identifier(active?.activeContextId), sourceThrough: finite(active?.sourceThrough),
      initialTurns: Array.isArray(active?.initialRequestIds) ? active.initialRequestIds.length : null,
      sourceDigest: identifier(active?.sourceDigest),
      migration: ["new", "legacy-reconstruction", "legacy-snapshot"].includes(String(active?.migration)) ? String(active!.migration) : null },
    checkpoint: { id: identifier(checkpoint?.id), through: finite(checkpoint?.through), sourceDigest: identifier(checkpoint?.sourceDigest),
      summaryDigest: typeof checkpoint?.summary === "string" ? sourceDigest(checkpoint.summary) : null },
    budget: { initialTokens: finite(projected?.initialTokens), estimatedTokens: finite(projected?.estimatedTokens), hard: finite(projected?.budget),
      trigger: finite(projected?.trigger), target: finite(projected?.target), attempts: finite(projected?.compactionAttempts),
      releasedTokens: finite(projected?.releasedTokens), degraded: reason(projected?.degraded), checkpointId: identifier(projected?.checkpointId),
      scope: finite(projected?.initialTokens) === null ? "unknown" : "complete-model-input" },
    recovery: { replayMs: finite(projected?.replayMs), processedEvents: finite(projected?.replayProcessedEvents) },
    coverage: { originalMessages: Array.isArray(coverage?.originalIds) ? coverage.originalIds.length : null,
      summarizedMessages: Array.isArray(coverage?.summaryIds) ? coverage.summaryIds.length : null },
    failures: own.filter((event) => event.type === "compaction_failed").map((event) => ({ reason: reason(event.reason),
      attempts: finite(event.attempts), budget: finite(event.budget), target: finite(event.target), failureKey: identifier(event.failureKey) })),
  };
}

/** Read production facts; all replay caches and simulated checkpoints stay temporary. */
export async function diagnoseContext(options: { dataDir: string; conversationId: string; requestId?: string; contextWindow?: number }) {
  const db = new DatabaseSync(join(options.dataDir, "runtime-v2.sqlite"), { readOnly: true });
  let events: StoredEvent[];
  try {
    events = conversationEvents(db.prepare("SELECT sequence,event_id,schema_version,session_id,payload FROM runtime_events ORDER BY sequence").all()
      // Preserve the production decoder's complete identity and key order: source digests certify these exact facts.
      .map((row) => ({ ...JSON.parse(String(row.payload)), schemaVersion: Number(row.schema_version),
        eventId: String(row.event_id), sequence: Number(row.sequence), sessionId: String(row.session_id) })), options.conversationId);
  } finally { db.close(); }
  const requestId = options.requestId ?? events.findLast((event) => event.type === "message" && event.role === "user")?.requestId;
  if (!requestId) throw new Error("诊断范围中没有用户轮次");
  const currentIndex = events.findIndex((event) => event.type === "message" && event.role === "user" && event.requestId === requestId);
  if (currentIndex < 0) throw new Error("诊断轮次不存在");
  const nextIndex = events.findIndex((event, index) => index > currentIndex && event.type === "message" && event.role === "user");
  if (nextIndex >= 0) events = events.slice(0, nextIndex);
  const recorded = recordedEvidence(events, requestId);
  const contextWindow = options.contextWindow ?? 128000;
  const model = { ...getModel("openai", "gpt-4o-mini"), contextWindow, maxTokens: Math.min(8192, Math.floor(contextWindow / 4)) };
  const budget = modelInputBudget(model).budget;
  const dir = await mkdtemp(join(tmpdir(), "nailong-context-diagnostic-"));
  try {
    const temp = createRuntimeLog(dir);
    const archives = createToolArchive(options.dataDir);
    let archiveRecoveries = 0;
    let sourceReads = 0;
    const log = { ...temp, read: async () => { sourceReads++; return [...structuredClone(events), ...await temp.read()]; }, recoverArchive: async (...args: Parameters<typeof archives.loadArchive>) => {
      archiveRecoveries++; return archives.loadArchive(...args);
    }, isArchiveRead: archives.isArchiveRead };
    const replay = await replayEvents(log, requestId, model, false);
    const messages = replay.units.flatMap((unit) => unit.messages);
    const initialEstimatedTokens = estimateInput({ messages });
    const legacyIds = new Set([...new Set(replay.units.flatMap((unit) => unit.requestId && unit.requestId !== requestId ? [unit.requestId] : []))].slice(-3));
    legacyIds.add(requestId);
    const legacyMessages = replay.units.filter((unit) => unit.requestId && legacyIds.has(unit.requestId))
      .flatMap((unit) => unit.requestId === requestId ? unit.messages : unit.summaryMessages ?? unit.messages);
    const cache = createReplayCache(dir, "offline-comparison-v1");
    await cache.replay(log, requestId, model, false);
    archiveRecoveries = 0;
    const warm = await cache.replay(log, requestId, model, false);
    const warmArchiveRecoveries = archiveRecoveries;
    archiveRecoveries = 0;
    const rebuilt = await replayEvents(log, requestId, model, false);
    const fullArchiveRecoveries = archiveRecoveries;
    const fullDigest = sourceDigest(rebuilt.units.flatMap((unit) => unit.messages));
    const warmDigest = sourceDigest(warm.units.flatMap((unit) => unit.messages));
    archiveRecoveries = 0;
    let simulatedSummaryCalls = 0;
    const projection = createContextProjection({ log, dataDir: dir, conversationId: options.conversationId, requestId, structured: false,
      summarize: async () => {
        if (++simulatedSummaryCalls > 100) throw new Error("诊断模拟超过 100 次摘要");
        return ["Goal", "Progress", "Constraints", "Decisions", "Next Steps", "Critical Context"]
          .map((heading) => `## ${heading}\n${"Diagnostic substitute; consult original evidence. ".repeat(3)}`).join("\n");
      } });
    let result: Awaited<ReturnType<typeof projection.project>> | undefined;
    try { result = await projection.project(model, { messages: [] }); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("上下文超过预算")) throw error; }
    const simulated = (await temp.read()).findLast((event) => event.type === "context_projected");
    return { historicalTurns: new Set(replay.units.filter((unit) => unit.requestId !== requestId).map((unit) => unit.requestId)).size,
      selectedMessages: replay.units.flatMap((unit) => unit.messages).length, sourceEvents: events.length,
      contextWindow, budget, initialEstimatedTokens, exceedsBudget: initialEstimatedTokens > budget,
      projectedEstimatedTokens: result ? estimateInput(result.context) : finite(simulated?.estimatedTokens), archiveRecoveries, simulatedSummaryCalls,
      simulationSucceeded: !!result, simulationFailure: reason(simulated?.degraded), recorded,
      comparison: { legacyRecentThreeTokens: estimateInput({ messages: legacyMessages }), legacyMessages: legacyMessages.length,
        activeSourceTokens: initialEstimatedTokens, activeSourceMessages: messages.length,
        fullDigest, warmDigest, equal: fullDigest === warmDigest, warmArchiveRecoveries, fullArchiveRecoveries,
        warmProcessedEvents: warm.processedEvents ?? null, fullProcessedEvents: rebuilt.processedEvents ?? null,
        scope: "uncompacted model-message sources; legacy selector and full historical tool results; projected estimate above includes simulated checkpoints; no Provider wire encoding" },
      simulatedLogReads: sourceReads,
      recordedSummaryCalls: events.filter((event) => event.type === "model_call_started" && event.requestId === requestId && event.purpose === "summary").length,
      recordedExecutionStarted: events.some((event) => event.type === "model_step_started" && event.requestId === requestId && event.purpose === "execution"),
      estimateScope: "messages only; excludes fixed prompt/tools and new Akasha recall; substitute summaries, not provider usage" };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
