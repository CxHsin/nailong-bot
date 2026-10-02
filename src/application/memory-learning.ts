import { memoryNodes } from "../runtime/memory-facts.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { MEMORY_ALGORITHM, learningSignal, memoryDynamics, type MemoryDynamics } from "../memory/dynamics.js";
import { memoryGraph, type MemoryInitialization } from "../memory/graph.js";

const pending = new WeakMap<RuntimeLog, Promise<void>>();
export function commitMemoryLearning(log: RuntimeLog, userId: number, config?: Partial<MemoryDynamics>, vector?: (text: string) => number[] | undefined): Promise<void> {
  const work = (pending.get(log) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const events = await log.read();
    const committed = new Set(events.filter((event) => event.type === "memory_learned").map((event) => event.requestId));
    const nodes = memoryNodes(events, userId);
    for (const current of nodes) {
      if (!current.requestId || committed.has(current.requestId) || !current.messages.some((message) => message.role === "assistant")) continue;
      const request = events.filter((event) => event.requestId === current.requestId);
      const terminal = request.find((event) => ["request_completed", "request_failed", "request_interrupted"].includes(event.type));
      const snapshot = request.find((event) => event.type === "memory_recalled");
      if (!terminal || !snapshot || !Array.isArray(snapshot.candidates)) continue;
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
      const deliveryAt = Math.min(...current.messages.filter((message) => message.role === "assistant")
        .map((message) => Date.parse(events[message.availableSequence ?? -1]?.at ?? message.at)));
      const settledAt = Math.max(Date.parse(terminal.at), deliveryAt);
      if (!Number.isFinite(settledAt)) continue;
      const qualification = Math.max(events.indexOf(terminal), Math.min(...current.messages.filter((message) => message.role === "assistant").map((message) => message.availableSequence ?? 0)));
      const initialization = memoryGraph(events.slice(0, qualification + 1), userId, vector, memoryDynamics(config)).initializations.find((item) => item.nodeId === current.id);
      const initializations = [initialization, ...activated.map((item) => candidates.find((candidate) => candidate.nodeId === item.nodeId)?.initialization)]
        .filter((item): item is MemoryInitialization => !!item);
      for (const item of initializations) if (!events.some((event) => event.type === "memory_initialized" && event.nodeId === item.nodeId && event.userId === userId)) {
        const { at: initializedAt, ...initial } = item;
        const fact = { type: "memory_initialized", ...initial, initializedAt };
        await log.append(fact); events.push({ ...fact, at: new Date(settledAt).toISOString() });
      }
      await log.append({ type: "memory_learned", requestId: current.requestId, userId, algorithm: MEMORY_ALGORITHM, origin: "online",
        snapshotId: snapshot.snapshotId, settledAt: new Date(settledAt).toISOString(), activated,
        dynamics: memoryDynamics(config), deliveredSources: current.messages.filter((message) => message.role === "assistant").map((message) => message.id) });
      committed.add(current.requestId);
    }
  });
  pending.set(log, work);
  return work;
}
