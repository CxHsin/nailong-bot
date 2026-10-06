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

/** Read production facts; all replay caches and simulated checkpoints stay temporary. */
export async function diagnoseContext(options: { dataDir: string; conversationId: string; requestId?: string; contextWindow?: number }) {
  const db = new DatabaseSync(join(options.dataDir, "runtime-v2.sqlite"), { readOnly: true });
  let events: StoredEvent[];
  try {
    events = conversationEvents(db.prepare("SELECT sequence,event_id,payload FROM runtime_events ORDER BY sequence").all()
      .map((row) => ({ ...JSON.parse(String(row.payload)), sequence: Number(row.sequence), eventId: String(row.event_id) })), options.conversationId);
  } finally { db.close(); }
  const requestId = options.requestId ?? events.findLast((event) => event.type === "message" && event.role === "user")?.requestId;
  if (!requestId) throw new Error("诊断范围中没有用户轮次");
  const currentIndex = events.findIndex((event) => event.type === "message" && event.role === "user" && event.requestId === requestId);
  if (currentIndex < 0) throw new Error("诊断轮次不存在");
  const nextIndex = events.findIndex((event, index) => index > currentIndex && event.type === "message" && event.role === "user");
  if (nextIndex >= 0) events = events.slice(0, nextIndex);
  const contextWindow = options.contextWindow ?? 128000;
  const model = { ...getModel("openai", "gpt-4o-mini"), contextWindow, maxTokens: Math.min(8192, Math.floor(contextWindow / 4)) };
  const budget = modelInputBudget(model).budget;
  const dir = await mkdtemp(join(tmpdir(), "nailong-context-diagnostic-"));
  try {
    const temp = createRuntimeLog(dir);
    const archives = createToolArchive(options.dataDir);
    let archiveRecoveries = 0;
    const log = { ...temp, read: async () => structuredClone(events), recoverArchive: async (...args: Parameters<typeof archives.loadArchive>) => {
      archiveRecoveries++; return archives.loadArchive(...args);
    }, isArchiveRead: archives.isArchiveRead };
    const replay = await replayEvents(log, requestId, model, false);
    const initialEstimatedTokens = estimateInput({ messages: replay.units.flatMap((unit) => unit.messages) });
    archiveRecoveries = 0;
    let simulatedSummaryCalls = 0;
    const projection = createContextProjection({ log, dataDir: dir, conversationId: options.conversationId, requestId, structured: false,
      summarize: async () => {
        if (++simulatedSummaryCalls > 100) throw new Error("诊断模拟超过 100 次摘要");
        return ["Goal", "Progress", "Constraints", "Decisions", "Next Steps", "Critical Context"]
          .map((heading) => `## ${heading}\n${"Diagnostic substitute; consult original evidence. ".repeat(12)}`).join("\n");
      } });
    const result = await projection.project(model, { messages: [] });
    return { historicalTurns: new Set(replay.units.filter((unit) => unit.requestId !== requestId).map((unit) => unit.requestId)).size,
      selectedMessages: replay.units.flatMap((unit) => unit.messages).length, sourceEvents: events.length,
      contextWindow, budget, initialEstimatedTokens, exceedsBudget: initialEstimatedTokens > budget,
      projectedEstimatedTokens: estimateInput(result.context), archiveRecoveries, simulatedSummaryCalls,
      recordedSummaryCalls: events.filter((event) => event.type === "model_call_started" && event.requestId === requestId && event.purpose === "summary").length,
      recordedExecutionStarted: events.some((event) => event.type === "model_step_started" && event.requestId === requestId && event.purpose === "execution"),
      estimateScope: "messages only; excludes fixed prompt/tools and new Akasha recall; substitute summaries, not provider usage" };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
