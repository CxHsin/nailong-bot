import { randomUUID } from "node:crypto";
import type { Request } from "./app-types.js";
import type { StoredEvent, ToolResult } from "../runtime/runtime-types.js";
import { memoryExclusions } from "../runtime/memory-facts.js";
import { filterMemoryToolResult, filterArchivedMemoryResult } from "../runtime/memory-exclusion.js";

export type ProgressSummaryInput = { task: string; explanations: string[]; facts: Array<{ id: string; type: string; name: string; result?: string }> };
export type ProgressSummaryGenerator = (input: ProgressSummaryInput, request: Request, signal: AbortSignal, onText: (text: string) => void) => Promise<string>;
export type ProgressSummaryOptions = { silenceMs?: number; intervalMs?: number; maxCalls?: number };

export function progressSummaryOptions(options: ProgressSummaryOptions = {}) {
  const resolved = { silenceMs: options.silenceMs ?? 15_000, intervalMs: options.intervalMs ?? 60_000, maxCalls: options.maxCalls ?? 5 };
  if (Object.values(resolved).some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("运行摘要阈值必须为正整数");
  return resolved;
}

/** Read-only side work. The main execution owns its own clock and never awaits this worker. */
export function startProgressSummaries(request: Request, task: string, generate: ProgressSummaryGenerator, options?: ProgressSummaryOptions) {
  const config = progressSummaryOptions(options);
  let lastMainText = Date.now(); let revision = 0; let stopped = false; let checking = false;
  let lastAttempt = -Infinity; let calls = 0; let consumed = -1;
  let primaryDraft = false;
  let controller: AbortController | undefined; let activeSegment: string | undefined;
  const valid = (generation: number) => !stopped && revision === generation && !request.signal?.aborted;
  const discard = () => {
    controller?.abort();
    if (activeSegment) request.onProgress?.({ type: "discard", segmentId: activeSegment });
    activeSegment = undefined;
  };
  const fact = (event: StoredEvent, index: number, events: StoredEvent[]) => {
    const result = event.result as ToolResult | undefined;
    const excluded = memoryExclusions(events);
    const filtered = result && filterArchivedMemoryResult(events, event, filterMemoryToolResult(String(event.toolName), result, excluded), excluded);
    return { id: String(event.eventId ?? index), type: event.type, name: String(event.toolName ?? ""),
      ...(filtered ? { result: JSON.stringify({ content: filtered.content.filter((part) => part.type === "text"), isError: filtered.isError }).slice(0, 2000) } : {}) };
  };
  const facts = (events: StoredEvent[]) => events.map((event, index) => ({ event, index })).filter(({ event }) =>
    event.requestId === request.id && ["tool_dispatch", "tool_result", "tool_blocked"].includes(event.type));
  const tick = async () => {
    if (checking || stopped || primaryDraft || calls >= config.maxCalls || Date.now() - lastMainText < config.silenceMs || Date.now() - lastAttempt < config.intervalMs) return;
    checking = true;
    const generation = revision;
    try {
      const events = await request.log.read();
      const relevant = facts(events);
      const cursor = relevant.at(-1)?.index ?? -1;
      if (cursor <= consumed || !valid(generation)) return;
      consumed = cursor; calls++; lastAttempt = Date.now();
      controller = new AbortController();
      activeSegment = randomUUID(); const segmentId = activeSegment;
      const discarded = new Set(events.filter((event) => event.type === "text_discarded").map((event) => event.textSegmentId));
      const input: ProgressSummaryInput = { task: task.slice(0, 8000),
        explanations: events.filter((event) => event.type === "text_finalized" && event.requestId === request.id && !discarded.has(event.textSegmentId)).slice(-4).map((event) => String(event.text).slice(0, 2000)),
        facts: relevant.slice(-12).map(({ event, index }) => fact(event, index, events)) };
      const text = await generate(input, request, controller.signal, (preview) => {
        if (valid(generation)) request.onProgress?.({ type: "text", segmentId, kind: "progress", text: preview, finalized: false, source: "progress-model" });
      });
      const latestFacts = facts(await request.log.read());
      if (!valid(generation) || !text.trim() || latestFacts.at(-1)?.index !== cursor) { discard(); return; }
      await request.log.append({ type: "text_finalized", requestId: request.id, textSegmentId: segmentId,
        text, contentKind: "progress", protocolVersion: "plain-text-v3", source: "progress-model", evidenceIds: input.facts.map((item) => item.id) });
      const settledFacts = facts(await request.log.read());
      if (!valid(generation) || settledFacts.at(-1)?.index !== cursor) {
        await request.log.append({ type: "text_discarded", requestId: request.id, textSegmentId: segmentId, reason: "stale_summary" });
        discard(); return;
      }
      request.onProgress?.({ type: "text", segmentId, kind: "progress", text, finalized: true, formal: true, source: "progress-model" });
      activeSegment = undefined;
    } catch { discard(); /* Commentary failure is isolated from task execution. */ }
    finally { checking = false; }
  };
  const timer = setInterval(() => { void tick(); }, Math.min(1000, config.silenceMs)); timer.unref();
  return {
    primaryText(finalized: boolean) { lastMainText = Date.now(); primaryDraft = !finalized; revision++; discard(); },
    stop() { stopped = true; revision++; clearInterval(timer); discard(); },
  };
}
