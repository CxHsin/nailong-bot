import type { MemoryNode } from "../runtime/memory-facts.js";
import type { MemoryDynamics } from "./dynamics.js";
import type { graphAt } from "./graph.js";

export type RecallConfig = { localMs: number; maxSeeds: number; maxLocalNodes: number; maxTransitions: number; iterations: number; restart: number; hubPower: number };
export const DEFAULT_RECALL: RecallConfig = { localMs: 30 * 60_000, maxSeeds: 16, maxLocalNodes: 256, maxTransitions: 8, iterations: 8, restart: 0.3, hubPower: 0.1 };
export function recallConfig(config: Partial<RecallConfig> = {}): RecallConfig {
  const result = { ...DEFAULT_RECALL, ...config };
  if (Object.values(result).some((value) => !Number.isFinite(value) || value <= 0) || result.restart >= 1 ||
    result.localMs > 86400_000 || result.maxSeeds > 32 || result.maxLocalNodes > 512 || result.maxTransitions > 32 || result.iterations > 32 ||
    [result.maxSeeds, result.maxLocalNodes, result.maxTransitions, result.iterations].some((value) => !Number.isSafeInteger(value))) throw new Error("记忆召回配置无效");
  return result;
}
export type ContentEvidence = { node: MemoryNode; evidence: number; similarity: number; sources: string[]; userEvidence: boolean };
export function rankMemories(content: ContentEvidence[], graph: ReturnType<typeof graphAt>, dynamics: MemoryDynamics, config = DEFAULT_RECALL) {
  const byId = new Map(content.map((item) => [item.node.id, item]));
  const edges = graph.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to) && edge.weight > 1e-8);
  const incoming = new Map<string, number>(); const outgoing = new Map<string, number>();
  for (const edge of edges) { incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1); outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1); }
  const totalDegree = (identity: string) => (incoming.get(identity) ?? 0) + (outgoing.get(identity) ?? 0);
  const state = (identity: string) => graph.states.get(identity);
  const normalizedStrength = (identity: string) => (state(identity)?.strength ?? 0) / dynamics.strengthCap;
  const gain = (identity: string) => Math.exp(1.4 * (state(identity)?.salience ?? 0) + normalizedStrength(identity)) * (state(identity)?.resource ?? 1) / Math.sqrt(1 + totalDegree(identity));
  const seedScore = (item: ContentEvidence) => item.evidence * gain(item.node.id);
  const direct = content.filter((item) => item.evidence > 0).sort((left, right) => seedScore(right) - seedScore(left) || left.node.id.localeCompare(right.node.id));
  const novel = direct.filter((item) => (state(item.node.id)?.salience ?? 0) >= 0.7).slice(0, Math.min(4, config.maxSeeds));
  const seeds = [...new Map([...direct.slice(0, config.maxSeeds - novel.length), ...novel].map((item) => [item.node.id, item])).values()].slice(0, config.maxSeeds);
  const localNodes = content.filter((item) => seeds.some((seed) => Math.abs(Date.parse(seed.node.at) - Date.parse(item.node.at)) <= config.localMs))
    .sort((left, right) => Number(seeds.some((seed) => seed.node.id === right.node.id)) - Number(seeds.some((seed) => seed.node.id === left.node.id)) ||
      seedScore(right) - seedScore(left) || left.node.id.localeCompare(right.node.id)).slice(0, config.maxLocalNodes);
  const localIds = new Set(localNodes.map((item) => item.node.id));
  const normalized = (edge: typeof edges[number]) => edge.weight / Math.sqrt((outgoing.get(edge.from) ?? 1) * (incoming.get(edge.to) ?? 1));
  const edgeSignal = (edge: typeof edges[number]) => normalized(edge) / Math.sqrt(1 + totalDegree(edge.to));
  const transitions = new Map(localNodes.map((item) => [item.node.id, edges.filter((edge) => edge.from === item.node.id && localIds.has(edge.to))
    .sort((left, right) => normalized(right) * gain(right.to) - normalized(left) * gain(left.to) || left.to.localeCompare(right.to)).slice(0, config.maxTransitions)]));
  const seedMass = seeds.reduce((sum, item) => sum + seedScore(item), 0);
  const start = new Map(seeds.map((item) => [item.node.id, seedMass ? seedScore(item) / seedMass : 0]));
  let mass = new Map(start);
  const paths = new Map<string, string[][]>(); const localSignal = new Map<string, number>();
  const addPath = (identity: string, path: string[]) => {
    const history = paths.get(identity) ?? [];
    if (history.length < 4 && !history.some((entry) => JSON.stringify(entry) === JSON.stringify(path))) paths.set(identity, [...history, path]);
  };
  for (let iteration = 0; iteration < config.iterations; iteration++) {
    const next = new Map([...start].map(([identity, value]) => [identity, config.restart * value]));
    for (const [identity, value] of mass) {
      const links = transitions.get(identity) ?? [];
      const total = links.reduce((sum, edge) => sum + edgeSignal(edge), 0);
      if (!total) { for (const [seed, weight] of start) next.set(seed, (next.get(seed) ?? 0) + (1 - config.restart) * value * weight); continue; }
      for (const edge of links) {
        const transferred = (1 - config.restart) * value * edgeSignal(edge) / total;
        next.set(edge.to, (next.get(edge.to) ?? 0) + transferred);
        localSignal.set(edge.to, Math.max(localSignal.get(edge.to) ?? 0, normalized(edge)));
        const previous = paths.get(identity)?.[0] ?? (start.has(identity) ? [identity] : undefined);
        if (previous && !previous.includes(edge.to) && previous.length <= config.iterations) {
          addPath(edge.to, [...previous, edge.to]);
        }
      }
    }
    mass = next;
  }
  const far = new Map<string, number>(); const farSignal = new Map<string, number>();
  for (const seed of seeds) for (const edge of edges.filter((entry) => entry.from === seed.node.id)
    .sort((left, right) => normalized(right) - normalized(left)).slice(0, config.maxTransitions)) {
    const neighbor = byId.get(edge.to)!;
    const signal = edgeSignal(edge);
    const score = 6 * (start.get(seed.node.id) ?? 0) * signal * Math.max(0, 0.25 + neighbor.similarity) * (1 + 0.15 * normalizedStrength(edge.to)) * (state(edge.to)?.resource ?? 1);
    far.set(edge.to, (far.get(edge.to) ?? 0) + score); farSignal.set(edge.to, (farSignal.get(edge.to) ?? 0) + signal);
    addPath(edge.to, [seed.node.id, edge.to]);
  }
  return content.map((item) => {
    const identity = item.node.id;
    const local = localSignal.has(identity) ? Math.min(1, (mass.get(identity) ?? 0) * 3 * gain(identity) *
      (0.25 + 0.75 * Math.max(item.similarity, item.evidence))) : 0;
    const distant = Math.min(1, far.get(identity) ?? 0);
    const hops = Math.min(...(paths.get(identity) ?? []).map((path) => path.length - 1));
    const ripple = Math.max(local, distant) * (Number.isFinite(hops) ? Math.pow(0.9, Math.max(0, hops - 1)) : 1);
    const roleEvidence = item.evidence * (item.userEvidence ? 1 : 0.85);
    const strong = Math.max(roleEvidence, ripple); const weak = Math.min(roleEvidence, ripple);
    const fused = strong + weak * (1 - strong);
    const novelty = state(identity)?.salience ?? 0;
    const edgeGain = Math.min(1, Math.max(localSignal.get(identity) ?? 0, farSignal.get(identity) ?? 0));
    const score = fused * (1 + 0.8 * novelty) * (1 + 0.6 * normalizedStrength(identity)) * (1 + 0.5 * edgeGain) /
      Math.pow(1 + totalDegree(identity), config.hubPower) * (0.5 + 0.5 * (state(identity)?.resource ?? 1));
    return { ...item, score, state: state(identity), paths: paths.get(identity) ?? [], sources: [...item.sources,
      ...(local > 0 ? ["local"] : []), ...(distant > 0 ? ["far"] : []), ...(novel.some((entry) => entry.node.id === identity) ? ["novel"] : [])] };
  }).filter((item) => Number.isFinite(item.score) && item.score > 1e-6)
    .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id));
}
