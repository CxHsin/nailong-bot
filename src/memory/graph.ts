import { memoryNodes } from "../runtime/memory-facts.js";
import type { StoredEvent } from "../runtime/runtime-types.js";
import { averageVectors, cosineOfUnitVectors } from "./embedding.js";
import { DEFAULT_DYNAMICS, MEMORY_ALGORITHM, boundedAdd, elapsed, memoryDynamics, settleNode, type MemoryDynamics } from "./dynamics.js";

export type MemoryState = { id: string; strength: number; resource: number; salience: number; at: number };
export type MemoryEdge = { from: string; to: string; weight: number; at: number };
export type MemoryInitialization = { nodeId: string; userId: number; algorithm: string; salience: number; strength: number; resource: number; at: number; mode: string };
export function memoryGraph(events: StoredEvent[], userId: number, vector?: (text: string) => number[] | undefined,
  config: MemoryDynamics = DEFAULT_DYNAMICS) {
  const originals = memoryNodes(events, userId);
  const states = new Map<string, MemoryState>(); const edges = new Map<string, MemoryEdge>();
  const chronology = originals.flatMap((node) => node.messages.map((message) => ({ node, message })))
    .sort((left, right) => (left.message.availableSequence ?? 0) - (right.message.availableSequence ?? 0));
  let centroid: number[] | undefined; let complete = true;
  const totals = new Map<string, number>();
  for (const { node, message } of chronology) {
    const current = vector?.(message.text);
    const direction = centroid ? averageVectors([centroid]) : undefined;
    const salience = complete && current && direction && current.length === direction.length ? Math.max(0, Math.min(1, (1 - cosineOfUnitVectors(current, direction)) * 2)) : 0;
    totals.set(node.id, Math.max(totals.get(node.id) ?? 0, salience));
    if (!current) { complete = false; continue; }
    if (!centroid) centroid = current.slice();
    else if (centroid.length === current.length) centroid = centroid.map((value, index) => value + current[index]!);
    else complete = false;
    const normalized = averageVectors([centroid]);
    if (!normalized) complete = false;
  }
  for (const node of originals) {
    const saved = events.find((event) => event.type === "memory_initialized" && event.nodeId === node.id && event.userId === userId &&
      event.algorithm === MEMORY_ALGORITHM && Number.isFinite(event.salience) && Number.isFinite(event.strength) && Number.isFinite(event.initializedAt));
    const salience = saved ? Number(saved.salience) : totals.get(node.id) ?? 0;
    const at = Date.parse(node.at); if (!Number.isFinite(at)) continue;
    states.set(node.id, { id: node.id, strength: saved ? Number(saved.strength) : config.strengthCap * (0.7 + 0.3 * salience), resource: 1, salience, at });
  }
  const initializations = [...states.values()].map((state): MemoryInitialization => ({ nodeId: state.id, userId, algorithm: MEMORY_ALGORITHM,
    salience: state.salience, strength: state.strength, resource: 1, at: state.at, mode: complete ? "semantic" : "semantic_unavailable" }));
  const applied = new Set<string>();
  for (const event of events) {
    if (event.type !== "memory_learned" || event.userId !== userId || event.algorithm !== MEMORY_ALGORITHM ||
      !event.requestId || applied.has(event.requestId) || !states.has(event.requestId) || !Array.isArray(event.activated)) continue;
    const now = Date.parse(String(event.settledAt)); if (!Number.isFinite(now)) continue;
    let parameters: MemoryDynamics;
    try { parameters = memoryDynamics(event.dynamics as Partial<MemoryDynamics>); } catch { continue; }
    const activated = (event.activated as Array<{ nodeId: string; signal: number }>).filter((item) => item.nodeId !== event.requestId &&
      states.has(item.nodeId) && Number.isFinite(item.signal) && item.signal > 0 && item.signal <= 1).slice(0, 8);
    const addEdge = (from: string, to: string, signal: number) => {
      const identity = JSON.stringify([from, to]);
      const previous = edges.get(identity);
      const at = Math.max(now, previous?.at ?? now);
      const weight = (previous?.weight ?? 0) * Math.exp(-elapsed(at, previous?.at ?? at) / parameters.edgeMs);
      edges.set(identity, { from, to, weight: boundedAdd(weight, parameters.edgeRate * signal, parameters.edgeCap), at });
    };
    for (const item of activated) {
      const previous = states.get(item.nodeId)!;
      const settled = settleNode(previous, now, parameters);
      states.set(item.nodeId, { ...previous, ...settled,
        strength: boundedAdd(settled.strength, parameters.strengthRate * item.signal, parameters.strengthCap),
        resource: Math.max(0, settled.resource - parameters.resourceRate * item.signal) });
      addEdge(item.nodeId, event.requestId, item.signal);
      addEdge(event.requestId, item.nodeId, item.signal * parameters.backwardRatio);
    }
    for (const [index, left] of activated.entries()) for (const right of activated.slice(index + 1)) {
      const signal = Math.sqrt(left.signal * right.signal);
      addEdge(left.nodeId, right.nodeId, signal); addEdge(right.nodeId, left.nodeId, signal);
    }
    applied.add(event.requestId);
  }
  return { states, edges, originals, initializations };
}
export function graphAt(graph: ReturnType<typeof memoryGraph>, now: number, config = DEFAULT_DYNAMICS) {
  return { states: new Map([...graph.states].map(([identity, state]) => [identity, { ...state, ...settleNode(state, now, config) }])),
    edges: [...graph.edges.values()].map((edge) => ({ ...edge, weight: edge.weight * Math.exp(-elapsed(now, edge.at) / config.edgeMs) })) };
}
