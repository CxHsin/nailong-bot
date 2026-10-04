import { randomUUID } from "node:crypto";
import type { Request } from "./app-types.js";
import type { StoredEvent } from "../runtime/runtime-types.js";

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
  const fact = (event: StoredEvent, index: number) => ({ id: String(event.eventId ?? index), type: event.type, name: String(event.toolName ?? ""),
    ...(event.type === "tool_result" ? { result: JSON.stringify(event.modelVisible ?? event.result).slice(0, 2000) } : {}) });
  const tick = async () => {
    if (checking || stopped || primaryDraft || calls >= config.maxCalls || Date.now() - lastMainText < config.silenceMs || Date.now() - lastAttempt < config.intervalMs) return;
    checking = true;
    const generation = revision;
    try {
      const events = await request.log.read();
      const relevant = events.map((event, index) => ({ event, index })).filter(({ event }) => event.requestId === request.id &&
        ["tool_dispatch", "tool_result", "tool_blocked"].includes(event.type));
      const cursor = relevant.at(-1)?.index ?? -1;
      if (cursor <= consumed || !valid(generation)) return;
      consumed = cursor; calls++; lastAttempt = Date.now();
      controller = new AbortController();
      activeSegment = randomUUID(); const segmentId = activeSegment;
      const input: ProgressSummaryInput = { task,
        explanations: events.filter((event) => event.type === "text_finalized" && event.requestId === request.id && event.source !== "progress-model").slice(-4).map((event) => String(event.text)),
        facts: relevant.slice(-12).map(({ event, index }) => fact(event, index)) };
      const text = await generate(input, request, controller.signal, (preview) => {
        if (valid(generation)) request.onProgress?.({ type: "text", segmentId, kind: "progress", text: preview, finalized: false, source: "progress-model" });
      });
      const latestFacts = (await request.log.read()).map((event, index) => ({ event, index })).filter(({ event }) =>
        event.requestId === request.id && ["tool_dispatch", "tool_result", "tool_blocked"].includes(event.type));
      if (!valid(generation) || !text.trim() || latestFacts.at(-1)?.index !== cursor) { discard(); return; }
      await request.log.append({ type: "text_finalized", requestId: request.id, textSegmentId: segmentId,
        text, contentKind: "progress", protocolVersion: "plain-text-v3", source: "progress-model", evidenceIds: input.facts.map((item) => item.id) });
      if (!valid(generation)) {
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
