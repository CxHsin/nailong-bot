import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PersistentAssistantQueue, inputPriority, type QueueInput, type PersistedInput, type ProcessingBatch, type BatchStatus, type RoutingAction, type RoutingDecision } from "./queue.js";
import type { AssistantOutput } from "./runtime.js";

export type { QueueInput, ProcessingBatch } from "./queue.js";
export type QueueExecutionContext = {
  signal: AbortSignal;
  emit: (output: AssistantOutput) => Promise<void>;
  recordSubmission: (submissionId: string) => void;
};
export type QueueExecutor = {
  execute(batch: ProcessingBatch, context: QueueExecutionContext): Promise<{status: Exclude<BatchStatus, "running">; reason?: string}>;
  close?: () => Promise<void>;
};
export type QueuedAssistantOptions = {
  dataDir: string;
  executor: QueueExecutor;
  startPaused?: boolean;
  reportFailure?: (error: unknown) => void;
};

export async function createQueuedAssistant(options: QueuedAssistantOptions) {
  await mkdir(options.dataDir, { recursive: true });
  const owner = new DatabaseSync(join(options.dataDir, "queue-owner.sqlite"));
  try { owner.exec("CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE"); }
  catch { owner.close(); throw new Error("助手数据目录正在被另一个进程使用"); }
  let queue: PersistentAssistantQueue;
  try { queue = new PersistentAssistantQueue(join(options.dataDir, "queue.sqlite")); }
  catch (error) { owner.close(); throw error; }
  const active = new Map<string, {promise: Promise<void>; batch: ProcessingBatch; controller: AbortController}>();
  const listeners = new Set<(output: AssistantOutput) => void | Promise<void>>();
  let closed = false;
  let started = false;
  const emit = async (output: AssistantOutput) => { for (const listener of listeners) await listener(output); };
  function pump(conversationId: string) {
    if (closed || !started || active.has(conversationId)) return;
    const batch = queue.claim(conversationId);
    if (!batch) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await options.executor.execute(batch, { signal: controller.signal, emit,
          recordSubmission: (id) => queue.recordSubmission(batch.id, id) });
        queue.settle(batch.id, result.status, result.reason);
      } catch (error) {
        if (!closed && controller.signal.aborted) queue.settle(batch.id, "preempted");
        else if (!closed) {
          queue.settle(batch.id, "paused", error instanceof Error ? error.message : String(error));
          (options.reportFailure ?? console.error)(error);
        }
      } finally { active.delete(conversationId); if (!closed) pump(conversationId); }
    });
    active.set(conversationId, {promise, batch, controller});
  }
  const service = {
    start() {
      if (closed) throw new Error("Assistant is closed");
      started = true;
      for (const id of queue.conversations()) pump(id);
    },
    async receive(input: QueueInput, routingPending = false) {
      if (closed) throw new Error("Assistant is closed");
      const receipt = queue.receive(input,routingPending);
      if (!options.startPaused) started = true;
      const running = active.get(input.conversationId);
      if (receipt.accepted && running && inputPriority(input) > running.batch.events[0]!.priority)
        running.controller.abort("higher-priority-input");
      pump(input.conversationId);
      return receipt;
    },
    async enqueueInternal(input: QueueInput) {
      if (closed) throw new Error("Assistant is closed");
      const receipt = queue.receiveInternal(input);
      if (!options.startPaused) started = true;
      pump(input.conversationId);
      return receipt;
    },
    getActiveBatch(conversationId: string) { return active.get(conversationId)?.batch; },
    getBatch(batchId: string) { return queue.getBatch(batchId); },
    recoverSteerTarget(batchId: string) { queue.recoverSteerTarget(batchId); },
    listBatches(conversationId?: string, statuses?: BatchStatus[]) { return queue.listBatches(conversationId,statuses); },
    listPending(conversationId?: string) { return queue.listPending(conversationId); },
    listWorks(conversationId?: string) { return queue.listWorks(conversationId); },
    routingPending(conversationId?: string) { return queue.routingPending(conversationId); },
    routingRecord(eventId: string) { return queue.routingRecord(eventId); },
    pendingHelperRoutes() { return queue.pendingHelperRoutes(); },
    decideRoute(eventId: string, decision: RoutingDecision) { return queue.decideRoute(eventId,decision); },
    updateAction(eventId: string, action: RoutingAction) { return queue.updateAction(eventId,action); },
    finishRoute(eventId: string) {
      const route=queue.routingPending().find((candidate)=>candidate.eventId===eventId);
      queue.finishRoute(eventId);
      if(route) pump(route.input.conversationId);
    },
    enqueueRoutedRequest(eventId: string, actionId: string) { return queue.enqueueRoutedRequest(eventId,actionId); },
    requeueAction(eventId: string, actionId: string, reason: string) { const work = queue.requeueAction(eventId,actionId,reason); pump(work.conversationId); return work; },
    supplementWork(targetId: string, input: PersistedInput, actionId: string) { return queue.supplementWork(targetId,input,actionId); },
    cancelWork(targetId: string, helper = false) { return queue.cancelWork(targetId,helper); },
    requestPreempt(conversationId: string) { active.get(conversationId)?.controller.abort("control"); },
    subscribe(listener: (output: AssistantOutput) => void | Promise<void>) {
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    async waitForIdle() { while (active.size) await Promise.all([...active.values()].map((entry) => entry.promise)); },
    async resume(conversationId: string, batchId?: string) { queue.resume(conversationId, batchId); pump(conversationId); },
    async close() {
      if (closed) return;
      closed = true;
      for (const entry of active.values()) entry.controller.abort("shutdown");
      await Promise.all([...active.values()].map((entry) => entry.promise));
      try { await options.executor.close?.(); }
      finally { queue.close(); owner.close(); }
    },
  };
  return service;
}
