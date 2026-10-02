import { memoryNodes, memoryExclusions, memoryQualification } from "../runtime/memory-facts.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { MEMORY_ALGORITHM, learningSignal, memoryDynamics, type MemoryDynamics } from "../memory/dynamics.js";
import { memoryGraph, type MemoryInitialization } from "../memory/graph.js";

const pending = new WeakMap<RuntimeLog, Promise<void>>();
export type MemoryLearningRecord = { type: "memory_learned"; requestId: string; userId: number; algorithm: string; origin: "online" | "historical";
  snapshotId: string; settledAt: string; dynamics: MemoryDynamics; deliveredSources: string[];
  activated: Array<{ nodeId: string; score: number; signal: number; shown: Array<{ nodeId: string; messageId: string; offset: number; end: number }> }>;
  [key: string]: unknown };
export function persistMemoryLearning(log: RuntimeLog, record: MemoryLearningRecord, initializations: MemoryInitialization[]): Promise<void> {
  const work = (pending.get(log) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const events = await log.read();
    if (events.some((event) => event.type === "memory_learned" && event.requestId === record.requestId)) return;
    const excluded = memoryExclusions(events);
    if (excluded.has(String(record.requestId))) return;
    for (const item of initializations) if (!excluded.has(item.nodeId) && !events.some((event) => event.type === "memory_initialized" && event.nodeId === item.nodeId && event.userId === item.userId)) {
      const { at: initializedAt, ...initial } = item;
      await log.append({ type: "memory_initialized", ...initial, initializedAt, origin: record.origin, settledAt: record.settledAt });
    }
    const activated = Array.isArray(record.activated) ? record.activated.filter((item) => !excluded.has(String(item.nodeId))) : [];
    await log.append({ ...record, activated });
  });
  pending.set(log, work); return work;
}
export function commitMemoryLearning(log: RuntimeLog, userId: number, config?: Partial<MemoryDynamics>, vector?: (text: string) => number[] | undefined): Promise<void> {
  return (async () => {
    const events = await log.read();
    const committed = new Set(events.filter((event) => event.type === "memory_learned").map((event) => event.requestId));
    const nodes = memoryNodes(events, userId);
    for (const current of nodes) {
      if (!current.requestId || committed.has(current.requestId) || !current.messages.some((message) => message.role === "assistant")) continue;
      const request = events.filter((event) => event.requestId === current.requestId);
      const qualification = memoryQualification(events, current);
      const snapshot = request.find((event) => event.type === "memory_recalled");
      if (!qualification || !snapshot || snapshot.mode === "dense" || !Array.isArray(snapshot.candidates)) continue;
      const parameters = memoryDynamics((snapshot.dynamics ?? config) as Partial<MemoryDynamics> | undefined);
      const presentations = request.filter((event) => event.type === "memory_presented" && event.snapshotId === snapshot.snapshotId);
      const shown = presentations.flatMap((event) => Array.isArray(event.shown) ? event.shown : []) as Array<{ nodeId: string; messageId: string; offset: number; end: number }>;
      const candidates = snapshot.candidates as Array<{ nodeId: string; score: number; initialization?: MemoryInitialization }>;
      const activated = candidates.slice(0, 8).flatMap((candidate) => {
        const original = nodes.find((node) => node.id === candidate.nodeId && node.id !== current.id);
        const references = shown.filter((reference) => reference.nodeId === original?.id && original.messages.some((message) =>
          message.id === reference.messageId && Number.isSafeInteger(reference.offset) && Number.isSafeInteger(reference.end) &&
          reference.offset >= 0 && reference.end > reference.offset && reference.end <= Array.from(message.text).length));
        const signal = learningSignal(candidate.score);
        return original && references.length && signal ? [{ nodeId: original.id, score: candidate.score, signal, shown: references }] : [];
      });
      const initialization = memoryGraph(events.slice(0, qualification.position + 1), userId, vector, parameters).initializations.find((item) => item.nodeId === current.id);
      const initializations = [initialization, ...activated.map((item) => candidates.find((candidate) => candidate.nodeId === item.nodeId)?.initialization)]
        .filter((item): item is MemoryInitialization => !!item);
      await persistMemoryLearning(log, { type: "memory_learned", requestId: current.requestId, userId, algorithm: MEMORY_ALGORITHM, origin: "online",
        snapshotId: String(snapshot.snapshotId), settledAt: qualification.settledAt, activated,
        dynamics: parameters, deliveredSources: qualification.deliveredSources }, initializations);
      committed.add(current.requestId);
    }
  })();
}
