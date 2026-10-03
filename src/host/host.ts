import { randomUUID } from "node:crypto";
import type { RuntimeLog, StoredEvent } from "../runtime/runtime-types.js";
import { upcastHostEvent, HOST_EVENT_SCHEMA_VERSION } from "./event-envelope.js";
import { normalizeContentParts, type ContentPart } from "./content-parts.js";

export type Actor = { id: string; kind?: "user" | "system" | "service"; displayName?: string };
export type HostInput = { actor: Actor; conversationId: string; parts: ContentPart[]; metadata?: Record<string, unknown> };
export type HostInputLike = Omit<HostInput, "parts"> & { parts?: unknown; text?: string; images?: unknown[] };
export type RunResult = { text?: string; resultId?: string; [key: string]: unknown };
export type ProgressMode = "quiet" | "normal" | "verbose";
export type HostEventType = "run_submitted" | "run_started" | "progress" | "run_blocked" |
  "run_recovered" | "run_succeeded" | "run_failed" | "run_cancelled" | "conversation_reset";
export type HostEvent = {
  type: HostEventType;
  schemaVersion: typeof HOST_EVENT_SCHEMA_VERSION;
  runId: string;
  conversationId: string;
  sequence: number;
  at: string;
  actorId?: string;
  phase?: string;
  source?: "runtime" | "provider" | "channel";
  visibility?: ProgressMode | "always";
  contextPolicy?: "include" | "exclude";
  text?: string;
  result?: RunResult;
  error?: string;
  reason?: string;
};

export type RunExecutionContext = {
  signal: AbortSignal;
  emit(event: Omit<HostEvent, "type" | "schemaVersion" | "runId" | "conversationId" | "sequence" | "at"> & { type: "progress" | "run_blocked" | "run_recovered" }): void;
};
export type HostExecutor = (input: HostInput, context: RunExecutionContext) => Promise<RunResult | string | void>;

class EventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false }); else this.values.push(value);
  }
  close() { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true }); }
  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.closed) return { value: undefined as never, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  async *iterate(): AsyncIterableIterator<T> { while (true) { const next = await this.next(); if (next.done) return; yield next.value; } }
}

export type RunHandle = {
  runId: string;
  conversationId: string;
  events(): AsyncIterable<HostEvent>;
  done: Promise<HostEvent>;
  cancel(): Promise<boolean>;
};

type Job = { input: HostInput; runId: string; queue: EventQueue<HostEvent>; done: Promise<HostEvent>; resolve: (event: HostEvent) => void; reject: (error: unknown) => void; controller: AbortController; sequence: number; cancelled: boolean; eventTail: Promise<void> };

export function normalizeHostInput(input: HostInputLike): HostInput {
  if (!input || typeof input !== "object") throw new Error("Host input 无效");
  const actor = input.actor;
  if (!actor || typeof actor.id !== "string" || !actor.id.trim()) throw new Error("Actor 身份缺失");
  if (typeof input.conversationId !== "string" || !input.conversationId.trim()) throw new Error("conversationId 缺失");
  const raw = input.parts !== undefined ? input.parts : [
    ...(typeof input.text === "string" ? [{ type: "text", text: input.text }] : []),
    ...(Array.isArray(input.images) ? input.images : []),
  ];
  return { actor: { id: actor.id, ...(actor.kind ? { kind: actor.kind } : {}), ...(actor.displayName ? { displayName: actor.displayName } : {}) },
    conversationId: input.conversationId, parts: normalizeContentParts(raw), ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}) };
}

export function createHost(options: { log: RuntimeLog; execute: HostExecutor; progressMode?: ProgressMode }) {
  let queue = Promise.resolve();
  const jobs = new Map<string, Job>();
  const appendNow = async (job: Job, type: HostEventType, extra: Partial<HostEvent> = {}): Promise<HostEvent> => {
    const event: HostEvent = { type, schemaVersion: HOST_EVENT_SCHEMA_VERSION, runId: job.runId,
      conversationId: job.input.conversationId, sequence: ++job.sequence, at: new Date().toISOString(), actorId: job.input.actor.id, ...extra };
    await options.log.append(event as unknown as Omit<StoredEvent, "at">);
    job.queue.push(event);
    return event;
  };
  const append = (job: Job, type: HostEventType, extra: Partial<HostEvent> = {}): Promise<HostEvent> => {
    let result!: HostEvent;
    const turn = job.eventTail.then(async () => { result = await appendNow(job, type, extra); });
    job.eventTail = turn;
    return turn.then(() => result);
  };
  const run = async (job: Job, submitted: Promise<unknown>) => {
    await submitted;
    await append(job, "run_started");
    try {
      const value = await options.execute(job.input, { signal: job.controller.signal, emit: (event) => {
        void append(job, event.type, event);
      } });
      if (job.controller.signal.aborted || job.cancelled) {
        const terminal = await append(job, "run_cancelled", { reason: "cancelled" }); job.resolve(terminal); return;
      }
      const result = typeof value === "string" ? { text: value } : value;
      const terminal = await append(job, "run_succeeded", result ? { result } : {}); job.resolve(terminal);
    } catch (error) {
      const cancelled = job.controller.signal.aborted || job.cancelled || (error instanceof DOMException && error.name === "AbortError");
      const terminal = await append(job, cancelled ? "run_cancelled" : "run_failed", { error: String(error), reason: cancelled ? "cancelled" : "execution" });
      job.resolve(terminal);
    } finally { job.queue.close(); jobs.delete(job.runId); }
  };
  const submit = (raw: HostInputLike): RunHandle => {
    const input = normalizeHostInput(raw);
    const runId = randomUUID();
    const eventQueue = new EventQueue<HostEvent>();
    let resolve!: (event: HostEvent) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<HostEvent>((res, rej) => { resolve = res; reject = rej; });
    const job: Job = { input, runId, queue: eventQueue, done, resolve, reject, controller: new AbortController(), sequence: 0, cancelled: false, eventTail: Promise.resolve() };
    jobs.set(runId, job);
    const submitted = append(job, "run_submitted");
    queue = queue.then(() => run(job, submitted)).catch((error) => { reject(error); eventQueue.close(); });
    return { runId, conversationId: input.conversationId, events: () => eventQueue.iterate(), done, cancel: () => cancel(runId) };
  };
  const cancel = async (runId: string) => { const job = jobs.get(runId); if (!job) return false; job.cancelled = true; job.controller.abort(); return true; };
  const reset = (conversationId: string): Promise<void> => {
    if (!conversationId.trim()) return Promise.reject(new Error("conversationId 缺失"));
    queue = queue.then(async () => {
      const job: Job = { input: { actor: { id: "system", kind: "system" }, conversationId, parts: [{ type: "text", text: "/reset" }] }, runId: randomUUID(), queue: new EventQueue(), done: Promise.resolve(undefined as never), resolve: () => {}, reject: () => {}, controller: new AbortController(), sequence: 0, cancelled: false, eventTail: Promise.resolve() };
      await append(job, "conversation_reset", { source: "channel", visibility: "always", contextPolicy: "exclude" });
      job.queue.close();
    });
    return queue;
  };
  return { submit, cancel, reset, async readEvents() { return (await options.log.read()).map(upcastHostEvent); } };
}
