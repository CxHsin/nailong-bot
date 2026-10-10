import { randomUUID } from "node:crypto";
import type { RuntimeLog, StoredEvent } from "../runtime/runtime-types.js";
import { upcastHostEvent, HOST_EVENT_SCHEMA_VERSION } from "./event-envelope.js";
import { normalizeContentParts, type ContentPart } from "./content-parts.js";
import type { RunProgress } from "../runtime/progress.js";

export type Actor = { id: string; kind?: "user" | "system" | "service"; displayName?: string };
export type HostInput = { actor: Actor; conversationId: string; parts: ContentPart[]; metadata?: Record<string, unknown> };
export type HostInputLike = Omit<HostInput, "parts"> & { parts?: unknown; text?: string; images?: unknown[] };
export type RunResult = { text?: string; resultId?: string; [key: string]: unknown };
export type ProgressMode = "quiet" | "normal" | "verbose";
export type HostEventType = "run_submitted" | "run_started" | "progress" | "run_blocked" |
  "run_recovered" | "run_succeeded" | "run_failed" | "run_cancelled" | "conversation_reset" | "input_receipt" | "control_received" | "control_completed";
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
  progress?: RunProgress;
  result?: RunResult;
  error?: string;
  reason?: string;
  parts?: ContentPart[];
  receiptId?: string;
  cancelledInputs?: number;
  inputKey?: string;
};

export type RunExecutionContext = {
  runId: string;
  conversationId: string;
  signal: AbortSignal;
  bindSteering: (listener: (steer: SteeringInput) => void) => () => void;
  emit(event: Omit<HostEvent, "type" | "schemaVersion" | "runId" | "conversationId" | "sequence" | "at"> & { type: "progress" | "run_blocked" | "run_recovered" }): void;
};
export type SteeringInput = { id: string; input: HostInput; consumed: boolean; consume: () => Promise<boolean>; applied: () => Promise<void> };
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

type Job = {
  input: HostInput; runId: string; queue: EventQueue<HostEvent>; done: Promise<HostEvent>;
  resolve: (event: HostEvent) => void; reject: (error: unknown) => void;
  controller: AbortController; sequence: number; cancelled: boolean; eventTail: Promise<void>;
  started?: boolean; closed?: boolean; control?: boolean; submitted?: Promise<unknown>;
  target?: Job; steeringOpen?: boolean; listener?: (steer: SteeringInput) => void;
  steering?: SteeringInput; ready?: boolean;
};

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

export function createHost(options: { log: RuntimeLog; execute: HostExecutor; readOnly?: (input: HostInput) => boolean; prepare?: (input: HostInput, steering: boolean) => Promise<void> }) {
  let queue = Promise.resolve();
  let readQueue = Promise.resolve();
  let preparation = Promise.resolve();
  const jobs = new Map<string, Job>();
  const acceptedKeys = new Set<string>();
  const restoredKeys = new Set<string>();
  let restoredDone = false;
  const restored = options.log.read().then((events) => {
    for (const event of events) if (typeof event.inputKey === "string") restoredKeys.add(event.inputKey);
    restoredDone = true;
  });
  queue = restored; readQueue = restored;
  const inputKey = (input: HostInput) => input.metadata?.messageId === undefined ? undefined : JSON.stringify([input.conversationId, input.actor.id, input.metadata.channel, input.metadata.messageId]);
  const appendNow = async (job: Job, type: HostEventType, extra: Partial<HostEvent> = {}): Promise<HostEvent> => {
    const event: HostEvent = { type, schemaVersion: HOST_EVENT_SCHEMA_VERSION, runId: job.runId,
      conversationId: job.input.conversationId, sequence: ++job.sequence, at: new Date().toISOString(), actorId: job.input.actor.id, ...extra };
    if (type === "input_receipt" || type === "control_completed") event.receiptId = `${job.runId}:receipt:${event.sequence}`;
    if (type === "run_submitted" || type === "control_received") event.inputKey = inputKey(job.input);
    // Host envelopes own their in-run sequence and schema version. The runtime log
    // assigns storage identity fields itself, so never persist those reserved keys.
    const { schemaVersion: _schemaVersion, sequence: _sequence, ...stored } = event;
    // Draft snapshots are ephemeral. Their underlying model/tool facts have their own log records.
    if (type !== "progress") await options.log.append(stored as unknown as Omit<StoredEvent, "at">);
    job.queue.push(event);
    return event;
  };
  const append = (job: Job, type: HostEventType, extra: Partial<HostEvent> = {}): Promise<HostEvent> => {
    let result!: HostEvent;
    const turn = job.eventTail.then(async () => { result = await appendNow(job, type, extra); });
    job.eventTail = turn;
    return turn.then(() => result);
  };
  const settle = (job: Job, terminal: HostEvent) => {
    job.closed = true; job.resolve(terminal); job.queue.close(); jobs.delete(job.runId);
  };
  const prepare = async (job: Job, steering: boolean) => {
    const validation = preparation.then(async () => {
      if (job.closed) return;
      const key = inputKey(job.input);
      if (key && (await options.log.read()).some((event) => event.inputKey === key && event.runId !== job.runId)) {
        job.closed = true;
        const terminal = await append(job, "control_completed", { phase: "duplicate", contextPolicy: "exclude" });
        settle(job, terminal); return;
      }
      await options.prepare?.(job.input, steering);
    });
    preparation = validation.then(() => {}, () => {});
    try { await validation; return !job.closed; }
    catch (error) {
      if (job.closed) return false;
      job.closed = true;
      const terminal = await append(job, "control_completed", { phase: "invalid", text: error instanceof Error ? error.message : "输入无效，请重新提交。", contextPolicy: "exclude" });
      settle(job, terminal); return false;
    }
  };
  const promoteSteer = async (job: Job) => {
    job.target = undefined;
    await append(job, "run_submitted", { parts: job.input.parts });
    await append(job, "input_receipt", { phase: "steer_fallback", text: "当前没有可引导的活动任务，已按普通输入排队。", contextPolicy: "exclude" });
  };
  const run = async (job: Job, submitted: Promise<unknown>) => {
    await submitted;
    if (job.closed) return;
    if (job.cancelled || job.controller.signal.aborted) {
      const terminal = await append(job, "run_cancelled", { reason: "cancelled_before_start" });
      settle(job, terminal); return;
    }
    job.started = true;
    job.steeringOpen = true;
    await append(job, "run_started");
    try {
      const value = await options.execute(job.input, { runId: job.runId, conversationId: job.input.conversationId, signal: job.controller.signal,
        bindSteering: (listener) => {
          job.listener = listener;
          for (const pending of jobs.values()) if (pending.target === job && pending.ready && pending.steering && !pending.closed) listener(pending.steering);
          return () => { job.steeringOpen = false; job.listener = undefined; };
        }, emit: (event) => {
        if (!job.closed) void append(job, event.type, event);
      } });
      if (job.controller.signal.aborted || job.cancelled) {
        job.closed = true;
        const terminal = await append(job, "run_cancelled", { reason: "cancelled" }); job.resolve(terminal); return;
      }
      const result = typeof value === "string" ? { text: value } : value;
      const reusable = result ? { ...result, resultId: result.resultId ?? job.runId } : { resultId: job.runId };
      job.closed = true;
      const terminal = await append(job, "run_succeeded", { result: reusable }); job.resolve(terminal);
    } catch (error) {
      const cancelled = job.controller.signal.aborted || job.cancelled || (error instanceof DOMException && error.name === "AbortError");
      job.closed = true;
      if (!cancelled) {
        const pending = cancelPending(job.input.conversationId, "previous_run_failed");
        if (pending.count) await append(job, "input_receipt", { phase: "failed_queue", text: `当前任务失败，已取消 ${pending.count} 条待处理输入，请按需重新提交。`, cancelledInputs: pending.count, contextPolicy: "exclude" });
        await pending.done;
      }
      const terminal = await append(job, cancelled ? "run_cancelled" : "run_failed", { error: String(error), reason: cancelled ? "cancelled" : "execution" });
      job.resolve(terminal);
    } finally {
      job.closed = true; job.steeringOpen = false;
      for (const steer of [...jobs.values()].filter((pending) => pending.target === job && !pending.closed)) {
        await steer.submitted;
        if (steer.target !== job || steer.closed) continue;
        steer.closed = true;
        const terminal = await append(steer, "control_completed", { phase: "steer_cancelled", text: "引导未生效，当前任务已结束，请按需重新提交。", contextPolicy: "exclude" });
        settle(steer, terminal);
      }
      job.queue.close(); jobs.delete(job.runId);
    }
  };
  const cancelPending = (conversationId: string, reason: string, candidates = [...jobs.values()]) => {
    const pending = candidates.filter((job) => job.input.conversationId === conversationId && !job.control && !job.started && !job.closed && !options.readOnly?.(job.input));
    for (const job of pending) { job.closed = true; job.cancelled = true; job.controller.abort(); }
    const done = Promise.all(pending.map(async (job) => {
      await job.submitted;
      const terminal = await append(job, job.target ? "control_completed" : "run_cancelled", { reason,
        ...(job.target ? { phase: "steer_cancelled", text: "待处理引导已取消。", contextPolicy: "exclude" as const } : {}) });
      settle(job, terminal);
    }));
    return { count: pending.length, done };
  };
  const submit = (raw: HostInputLike): RunHandle => {
    const input = normalizeHostInput(raw);
    const text = input.parts.map((part) => part.type === "text" ? part.text : "").join("\n").trim();
    const stop = /^\/stop(?:\s|$)/.test(text);
    const steer = /^\/steer(?:\s|$)/.test(text);
    if (steer) {
      const content = text.replace(/^\/steer\s*/, "");
      input.parts = [...(content ? [{ type: "text" as const, text: content }] : []), ...input.parts.filter((part) => part.type !== "text")];
    }
    const queued = !options.readOnly?.(input) && [...jobs.values()].some((job) => !job.control && !job.closed && !options.readOnly?.(job.input));
    const runId = randomUUID();
    const eventQueue = new EventQueue<HostEvent>();
    let resolve!: (event: HostEvent) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<HostEvent>((res, rej) => { resolve = res; reject = rej; });
    const job: Job = { input, runId, queue: eventQueue, done, resolve, reject, controller: new AbortController(), sequence: 0, cancelled: false, eventTail: Promise.resolve() };
    const handle = { runId, conversationId: input.conversationId, events: () => eventQueue.iterate(), done, cancel: () => cancel(runId) };
    const key = inputKey(input);
    if (key && (acceptedKeys.has(key) || restoredKeys.has(key))) {
      const terminal: HostEvent = { type: "control_completed", schemaVersion: HOST_EVENT_SCHEMA_VERSION, runId, conversationId: input.conversationId, sequence: 1, at: new Date().toISOString(), phase: "duplicate", contextPolicy: "exclude" };
      eventQueue.push(terminal); eventQueue.close(); resolve(terminal); return handle;
    }
    if (key) acceptedKeys.add(key);
    if (steer && input.parts.length) {
      const target = [...jobs.values()].find((other) => other.input.conversationId === input.conversationId && other.started && other.steeringOpen && !other.cancelled && !other.closed && !other.control);
      if (target) {
        const previousSteer = [...jobs.values()].findLast((other) => other.target === target);
        job.target = target;
        jobs.set(runId, job);
        job.submitted = append(job, "control_received", { phase: "steer", parts: input.parts, contextPolicy: "exclude" }).then(async () => {
          // Skill/image preparation may finish out of order; deliver in receipt order.
          await previousSteer?.submitted;
          if (!await prepare(job, true)) return;
          if (!target.steeringOpen || target.closed || target.cancelled) {
            await promoteSteer(job); return;
          }
          await append(job, "input_receipt", { phase: "steer_waiting", text: "引导已接收，等待当前工具批次完成。", contextPolicy: "exclude" });
          if (job.closed) return;
          if (!target.steeringOpen || target.closed || target.cancelled) {
            await promoteSteer(job); return;
          }
          job.ready = true;
          target.listener?.(job.steering!);
        });
        job.steering = { id: runId, input, consumed: false,
          consume: async () => {
            await job.submitted;
            if (job.closed || job.cancelled || target.cancelled) return false;
            job.steering!.consumed = true;
            await options.log.append({ type: "steer_consumed", inputId: runId, requestId: target.runId, conversationId: input.conversationId, contextPolicy: "exclude" });
            return true;
          },
          applied: async () => {
            if (job.closed) return;
            job.closed = true;
            const terminal = await append(job, "control_completed", { phase: "steer_applied", text: "引导已生效。", contextPolicy: "exclude" });
            settle(job, terminal);
          } };
        // Reserve receipt order now. Applied controls close this slot; a Steer
        // whose target ends during validation becomes an ordinary Run here.
        schedule(job);
        return handle;
      }
    }
    if (steer && !input.parts.length) {
      job.control = true; jobs.set(runId, job);
      void append(job, "control_completed", { phase: "invalid", text: "用法：/steer 内容（可附图片）", contextPolicy: "exclude" }).then((terminal) => {
        settle(job, terminal);
      });
      return handle;
    }
    if (stop) {
      job.control = true;
      const active = [...jobs.values()].find((other) => other.input.conversationId === input.conversationId && other.started && !other.target && !other.closed && !other.control && !options.readOnly?.(other.input));
      const valid = text === "/stop" && input.parts.every((part) => part.type === "text");
      const candidates = [...jobs.values()];
      jobs.set(runId, job);
      void (async () => {
        if (!restoredDone) await restored;
        if (key && restoredKeys.has(key)) {
          const terminal = await append(job, "control_completed", { phase: "duplicate", contextPolicy: "exclude" });
          settle(job, terminal); return;
        }
        const pending = valid ? cancelPending(input.conversationId, "stopped_before_start", candidates) : { count: 0, done: Promise.resolve() };
        if (valid && active && !active.closed) { active.cancelled = true; active.controller.abort(); }
        job.submitted = append(job, "control_received", { phase: "stop", parts: input.parts, contextPolicy: "exclude" });
        await job.submitted;
        if (valid && active) await append(job, "input_receipt", { phase: "stopping", text: "正在停止当前任务。", contextPolicy: "exclude" });
        await pending.done;
        if (valid && active) await active.done;
        const text = !valid ? "用法：/stop" : active ? `已停止，已取消 ${pending.count} 条待处理输入。` : pending.count ? `已取消 ${pending.count} 条待处理输入，当前没有运行中的任务。` : "当前没有运行中或待处理的任务。";
        const terminal = await append(job, "control_completed", { phase: valid ? active ? "stopped" : "idle" : "invalid", text, cancelledInputs: pending.count, contextPolicy: "exclude" });
        settle(job, terminal);
      })().catch((error) => { job.reject(error); job.queue.close(); jobs.delete(runId); });
      return handle;
    }
    jobs.set(runId, job);
    const submitted = append(job, "run_submitted", { parts: structuredClone(input.parts) }).then(async () => {
      if (!await prepare(job, steer)) return;
      if (steer) await append(job, "input_receipt", { phase: "steer_fallback", text: "当前没有可引导的活动任务，已按普通输入处理。", contextPolicy: "exclude" });
      if (queued) await append(job, "input_receipt", { phase: "queued", text: "已排队，当前任务完成后处理。", contextPolicy: "exclude" });
    });
    job.submitted = submitted;
    schedule(job);
    return handle;
  };
  function schedule(job: Job) {
    const execute = (tail: Promise<void>) => tail.then(() => run(job, job.submitted!)).catch((error) => { job.reject(error); job.queue.close(); jobs.delete(job.runId); });
    if (options.readOnly?.(job.input)) readQueue = execute(readQueue); else queue = execute(queue);
  }
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
  const redeliver = async (resultId: string, deliver: (result: RunResult) => Promise<void>): Promise<RunResult> => {
    const events = (await options.log.read()).map(upcastHostEvent);
    const event = events.findLast((entry) => entry.type === "run_succeeded" &&
      entry.result && typeof entry.result === "object" && (entry.result as RunResult).resultId === resultId);
    if (!event?.result || typeof event.result !== "object") throw new Error("找不到可复用的运行结果");
    const result = event.result as RunResult;
    await deliver(structuredClone(result));
    return result;
  };
  return { submit, cancel, reset, redeliver,
    isBusy(conversationId: string) { return [...jobs.values()].some((job) => job.input.conversationId === conversationId && !job.control && !job.closed && !options.readOnly?.(job.input)); },
    async readEvents() { return (await options.log.read()).map(upcastHostEvent); } };
}
