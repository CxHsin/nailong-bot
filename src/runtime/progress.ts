import type { RuntimeLog, StoredEvent } from "./runtime-types.js";

export type ProgressMode = "quiet" | "normal" | "verbose";
export type ProgressKind = "reasoning_summary" | "commentary" | "tool_started" | "tool_completed" | "blocked" |
  "recovered" | "terminal" | "failure" | "cancellation" | "delta" | "silence_fallback";
export type ProgressEvent = {
  type: "progress";
  runId: string;
  conversationId: string;
  sequence: number;
  at: string;
  kind: ProgressKind;
  phase: string;
  source: "provider" | "runtime" | "channel";
  visibility: ProgressMode | "always";
  contextPolicy: "include" | "exclude";
  durable: boolean;
  identity?: string;
  resultId?: string;
  text?: string;
  evidence?: Record<string, unknown>;
};
type ProgressInput = Omit<ProgressEvent, "type" | "runId" | "conversationId" | "sequence" | "at" | "durable"> & { durable?: boolean };

export function projectProgress(events: ProgressEvent[], mode: ProgressMode): ProgressEvent[] {
  return events.filter((event) => mode === "verbose" || event.visibility === "always" ||
    mode === "normal" && event.visibility === "normal" ||
    mode === "quiet" && ["failure", "recovered", "blocked", "terminal", "cancellation"].includes(event.kind));
}

export function createProgressPipeline(options: { log: RuntimeLog; maxSilenceMs?: number }) {
  const maxSilenceMs = options.maxSilenceMs ?? 15_000;
  const eventsByRun = new Map<string, ProgressEvent[]>();
  const sequenceByRun = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const stoppedRuns = new Set<string>();
  const append = async (event: ProgressEvent) => {
    const events = eventsByRun.get(event.runId) ?? [];
    events.push(event); eventsByRun.set(event.runId, events);
    if (event.durable) await options.log.append({ ...event, type: "progress_event" });
    return event;
  };
  const schedule = (runId: string, conversationId: string) => {
    clearTimeout(timers.get(runId));
    const timer = setTimeout(() => {
      void emit(runId, conversationId, { kind: "silence_fallback", phase: "waiting", source: "runtime", visibility: "normal", contextPolicy: "exclude", text: "仍在处理中" });
    }, maxSilenceMs);
    timer.unref?.();
    timers.set(runId, timer);
  };
  async function emit(runId: string, conversationId: string, input: ProgressInput): Promise<ProgressEvent> {
    const event: ProgressEvent = { type: "progress", runId, conversationId, sequence: (sequenceByRun.get(runId) ?? 0) + 1,
      at: new Date().toISOString(), durable: input.durable ?? !["delta", "commentary"].includes(input.kind), ...input };
    sequenceByRun.set(runId, event.sequence);
    const result = await append(event);
    if (event.kind === "terminal" || event.kind === "failure" || event.kind === "cancellation") {
      stoppedRuns.add(runId);
      clearTimeout(timers.get(runId));
      timers.delete(runId);
    }
    else if (event.durable && !stoppedRuns.has(runId)) schedule(runId, conversationId);
    return result;
  }
  return { emit, stop(runId: string) { stoppedRuns.add(runId); clearTimeout(timers.get(runId)); timers.delete(runId); },
    async events(runId: string) { return (eventsByRun.get(runId) ?? []).slice(); },
    async recover(runId: string) { const stored = await options.log.read(); return stored.filter((event) => event.type === "progress_event" && event.runId === runId) as unknown as ProgressEvent[]; } };
}

export function progressEventsFromStored(events: StoredEvent[]): ProgressEvent[] {
  return events.filter((event) => event.type === "progress_event" && typeof event.runId === "string" && Number.isSafeInteger(event.sequence)) as unknown as ProgressEvent[];
}
