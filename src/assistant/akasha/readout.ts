// Ported from akashic-agent 94027a5c, MIT, Copyright (c) 2026 kachofugetsu09.
// Full license notice is in ./LICENSE.
// V8 multi-basin pattern completion; source function names retain oracle correspondence.
import { residual_push } from "./diffusion.js";
import { TEMPORAL_BACKWARD, TEMPORAL_FORWARD, type DynamicMemoryGraph } from "./graph.js";
import type { FeaturePool } from "./features.js";
import type { ContextState, DiffusionResult, MemoryConfig, SeedEvidence, Turn, WeightedNodes } from "./model.js";
import { binary_entropy, entmax, fsum, numpy_sum, sparsemax, tail_surprisal } from "./numeric.js";

export interface Basin { hub_id: number; score: number; members: number[]; weights: number[] }
interface BasinStructure {
  hub_id: number; members: number[]; weights: number[]; normalized: Float64Array; conductance: number;
}
export interface RecallItem { node_id: number; score: number; sources: string[]; basin_ids: string[] }
export interface PatternCompletion {
  items: RecallItem[]; active_basin_count: number; sharp_completion_count: number;
  basin_direct_count: number; basin_completion_count: number; relative_tail_count: number;
  pushes: number; residual_l1: number;
}
export interface RecallCapture { query_node_id: number; completion: PatternCompletion }
type Fields = Record<string, Float64Array>;
type Head = [id: string, mass: number, seed: WeightedNodes];
type SelectedHead = [basin: Basin, mass: number, seed: WeightedNodes];
interface CompletionComponents {
  sharp: Set<number>; direct: Set<number>; completion: Set<number>; tail: Set<number>;
  basin_mass: Map<number, number>; tail_mass: Map<number, number>; basin_ids: Map<number, Set<string>>;
}
interface ReadOptions {
  graph: DynamicMemoryGraph; pool: FeaturePool; query: Turn; context: ContextState;
  precomputed_fields?: Fields | null; evidence: SeedEvidence; diffusion: DiffusionResult;
  historical_surprise: Float64Array; config: MemoryConfig; context_dependence: number;
  visible_nodes?: readonly number[]; burst_continued?: boolean; inhibited_nodes?: ReadonlySet<number>;
}
const maximum = (values: Iterable<number>) => {
  let peak = -Infinity;
  for (const value of values) peak = Math.max(peak, value);
  return peak;
};

/** Expose only directed temporal relations while sharing the prepared graph's weights. */
export class TemporalGraphView {
  readonly max_nodes: number;
  private readonly transition_cache = new Map<number, [Array<[number, number, number]>, number]>();
  constructor(readonly graph: DynamicMemoryGraph) { this.max_nodes = graph.max_nodes; }
  transitions(node_id: number, _event: number): [Array<[number, number, number]>, number] {
    const cached = this.transition_cache.get(node_id);
    if (cached) return cached;
    const weighted: Array<[number, number, number]> = [];
    for (const edge_id of this.graph.adjacency[node_id]!) {
      if (this.graph.kind[edge_id] !== TEMPORAL_FORWARD && this.graph.kind[edge_id] !== TEMPORAL_BACKWARD) continue;
      const weight = this.graph.effective_weight(edge_id);
      if (weight <= 0) continue;
      const target = this.graph._outgoing_target(edge_id, node_id);
      if (target !== null) weighted.push([target, weight, edge_id]);
    }
    const total = fsum(weighted.map(([, weight]) => weight));
    const spread = -Math.expm1(-total);
    const result: [Array<[number, number, number]>, number] = total === 0 ? [[], 1] :
      [weighted.map(([target, weight, edge_id]) => [target, spread * weight / total, edge_id]), 1 - spread];
    this.transition_cache.set(node_id, result);
    return result;
  }
}

/** Read contextual and independent basin routes without changing the prepared memory graph. */
export function read_pattern_completion(options: ReadOptions): PatternCompletion {
  const { graph, pool, query, context, evidence, diffusion, historical_surprise, config } = options;
  const visible_nodes = options.visible_nodes ?? [];
  const burst_continued = options.burst_continued ?? true;
  const structures = active_basin_structures(graph, query.node_id);
  const fields = options.precomputed_fields ? reuse_evidence_fields(options.precomputed_fields, burst_continued) :
    evidence_fields(pool, query.node_id, context);
  const basin_scores = Float64Array.from(fields.current!, (value, index) =>
    value + evidence.continuation * (fields.same_event![index]! - value));
  const contextual = exclude_recall_items(read_route({ graph, query, fields, basin_scores,
    continuation: evidence.continuation, surprise: evidence.surprise, diffusion, historical_surprise, config,
    visible_nodes, burst_continued, structures }), options.inhibited_nodes ?? new Set());
  const address_mass = independent_address_mass(options.context_dependence);
  if (address_mass === 0) return contextual;
  const address_fields = options.precomputed_fields ? reuse_evidence_fields(options.precomputed_fields, false) :
    evidence_fields(pool, query.node_id, { members: [], dense: null, terms: [] });
  const address_diffusion = residual_push(graph, sparsemax(address_fields.current!), query.node_id,
    { restart: config.restart, tolerance: config.tolerance, capture_paths: false });
  const address = exclude_recall_items(read_route({ graph, query, fields: address_fields,
    basin_scores: address_diffusion.reserve.slice(0, query.node_id), continuation: 0, surprise: evidence.surprise,
    diffusion: address_diffusion, historical_surprise, config, visible_nodes, burst_continued: false, structures }),
  options.inhibited_nodes ?? new Set());
  return competitive_route_union(contextual, address, address_mass);
}

function exclude_recall_items(completion: PatternCompletion, excluded: ReadonlySet<number>): PatternCompletion {
  if (!excluded.size) return completion;
  const items = completion.items.filter(item => !excluded.has(item.node_id));
  return { ...completion, items, ...source_counts(items) };
}

function source_counts(items: readonly RecallItem[]) {
  return {
    sharp_completion_count: items.filter(item => item.sources.includes("sharp_completion")).length,
    basin_direct_count: items.filter(item => item.sources.includes("basin_direct")).length,
    basin_completion_count: items.filter(item => item.sources.includes("basin_completion")).length,
    relative_tail_count: items.filter(item => item.sources.includes("relative_tail")).length,
  };
}

function independent_address_mass(context_dependence: number): number {
  if (context_dependence === 0) return 1;
  if (context_dependence === 1) return 0;
  return sparsemax(new Float64Array([Math.log(1 - context_dependence), Math.log(context_dependence)]))
    .find(([node]) => node === 0)?.[1] ?? 0;
}

function competitive_route_union(contextual: PatternCompletion, address: PatternCompletion, address_mass: number): PatternCompletion {
  const contextual_nodes = new Set(contextual.items.map(item => item.node_id));
  const contextual_scores = new Map(contextual.items.map(item => [item.node_id, item.score]));
  const items = new Map(contextual.items.map(item => [item.node_id, item]));
  for (const item of address.items) {
    if (!item.sources.includes("basin_completion")) continue;
    const previous = items.get(item.node_id);
    items.set(item.node_id, previous ? { node_id: item.node_id, score: Math.max(previous.score, item.score),
      sources: [...new Set([...previous.sources, ...item.sources])].sort(),
      basin_ids: [...new Set([...previous.basin_ids, ...item.basin_ids])].sort() } : item);
  }
  const ordered = [...items.values()].sort((a, b) => b.score - a.score || a.node_id - b.node_id);
  const scores = Float64Array.from(ordered, item => Math.max(contextual_scores.get(item.node_id) ?? address_mass * item.score, 0));
  const peak = scores.length ? maximum(scores) : 0;
  const supported = peak > 0 ? new Set(sparsemax(scores.map(value => value / peak)).map(([index]) => ordered[index]!.node_id)) : new Set();
  const selected = ordered.filter(item => contextual_nodes.has(item.node_id) || supported.has(item.node_id));
  return { items: selected, active_basin_count: contextual.active_basin_count + address.active_basin_count,
    ...source_counts(selected), pushes: contextual.pushes + address.pushes,
    residual_l1: Math.max(contextual.residual_l1, address.residual_l1) };
}

function read_route(options: {
  graph: DynamicMemoryGraph; query: Turn; fields: Fields; basin_scores: Float64Array;
  continuation: number; surprise: number; diffusion: DiffusionResult; historical_surprise: Float64Array;
  config: MemoryConfig; visible_nodes: readonly number[]; burst_continued: boolean; structures: BasinStructure[];
}): PatternCompletion {
  const { graph, query, fields, continuation, diffusion, config, visible_nodes } = options;
  const basins = score_active_basins(options.structures, options.basin_scores);
  let temperature = surprise_temperature(options.surprise, options.historical_surprise);
  if (!options.burst_continued) temperature *= binary_entropy(continuation);
  const heads = accessibility_supported_heads(graph, pooled_heads(basins, fields, continuation, temperature));
  const components = diffuse_heads(graph, query, fields, diffusion, heads, continuation, config);
  const visible = new Set(visible_nodes);
  const items = recall_items(components, diffusion.reserve).filter(item => !visible.has(item.node_id));
  return { items, active_basin_count: heads.length, ...source_counts(items),
    pushes: diffusion.pushes, residual_l1: diffusion.residual_l1 };
}

function diffuse_heads(graph: DynamicMemoryGraph, query: Turn, fields: Fields, sharp_diffusion: DiffusionResult,
  heads: Head[], continuation: number, config: MemoryConfig): CompletionComponents {
  const components: CompletionComponents = {
    sharp: completion_support(sharp_diffusion, [], query.node_id, config.restart),
    direct: new Set(heads.flatMap(([, , seed]) => seed.map(([node]) => node))), completion: new Set(), tail: new Set(),
    basin_mass: new Map(), tail_mass: new Map(), basin_ids: new Map(),
  };
  const sharp_posterior = turn_posterior(sharp_diffusion, query.node_id);
  const temporal = new TemporalGraphView(graph);
  for (const [head_id, head_mass, seed] of heads) {
    const basin_diffusion = residual_push(graph, seed, query.node_id,
      { restart: config.restart, tolerance: config.tolerance, capture_paths: false });
    const temporal_diffusion = residual_push(temporal, seed, query.node_id,
      { restart: config.restart, tolerance: config.tolerance, capture_paths: false });
    const local_completion = completion_support(basin_diffusion, seed, query.node_id, config.restart);
    for (const node of local_completion) components.completion.add(node);
    const posterior = turn_posterior(basin_diffusion, query.node_id);
    const temporal_posterior = turn_posterior(temporal_diffusion, query.node_id);
    const relative = relative_tail_entmax15(posterior, sharp_posterior, temporal_posterior, components.direct);
    const add_id = (node: number) => {
      if (!components.basin_ids.has(node)) components.basin_ids.set(node, new Set());
      components.basin_ids.get(node)!.add(head_id);
    };
    for (const [node, value] of seed) {
      components.basin_mass.set(node, (components.basin_mass.get(node) ?? 0) + head_mass * value); add_id(node);
    }
    for (const node of local_completion) {
      components.basin_mass.set(node, (components.basin_mass.get(node) ?? 0) + head_mass * posterior[node]!); add_id(node);
    }
    for (const [node, value] of relative) {
      components.tail_mass.set(node, (components.tail_mass.get(node) ?? 0) + head_mass * value); add_id(node);
    }
  }
  components.tail = filter_tail_by_agreement(shared_tail(components.tail_mass), components.tail_mass,
    cue_agreement(fields, continuation));
  return components;
}

function recall_items(components: CompletionComponents, sharp_reserve: Float64Array): RecallItem[] {
  const nodes = new Set([...components.sharp, ...components.direct, ...components.completion, ...components.tail]);
  const labels = [["sharp_completion", components.sharp], ["basin_direct", components.direct],
    ["basin_completion", components.completion], ["relative_tail", components.tail]] as const;
  return [...nodes].map(node => ({ node_id: node,
    score: Math.max(sharp_reserve[node]!, components.basin_mass.get(node) ?? 0, components.tail_mass.get(node) ?? 0),
    sources: labels.filter(([, members]) => members.has(node)).map(([name]) => name),
    basin_ids: [...(components.basin_ids.get(node) ?? [])].sort(),
  })).sort((first, second) => second.score - first.score || first.node_id - second.node_id);
}

function evidence_fields(pool: FeaturePool, index: number, context: ContextState): Fields {
  const query = pool.turns[index]!;
  const total = fsum(query.user_terms.map(([, value]) => value));
  const terms = new Map(total === 0 ? [] : query.user_terms.map(([term, value]) => [term, value / total]));
  const current_dense = tail_surprisal(pool.dense_scores(query.user_dense, index));
  const current_bm25 = tail_surprisal(pool.bm25_scores(terms, index));
  const context_dense = tail_surprisal(pool.dense_scores(context.dense, index));
  const context_bm25 = tail_surprisal(pool.bm25_scores(new Map(context.terms), index));
  return assembled_fields(current_dense, current_bm25, context_dense, context_bm25);
}

function reuse_evidence_fields(source: Fields, include_context: boolean): Fields {
  return assembled_fields(source.query_dense!, source.query_bm25!,
    include_context ? source.context_dense! : new Float64Array(source.query_dense!.length),
    include_context ? source.context_bm25! : new Float64Array(source.query_bm25!.length));
}

function assembled_fields(current_dense: Float64Array, current_bm25: Float64Array,
  context_dense: Float64Array, context_bm25: Float64Array): Fields {
  const current = Float64Array.from(current_dense, (value, index) => value + current_bm25[index]!);
  const same_event = Float64Array.from(current, (value, index) => value + context_dense[index]! + context_bm25[index]!);
  return { current, same_event, current_dense, current_bm25, context_dense, context_bm25 };
}

function active_basin_structures(graph: DynamicMemoryGraph, event: number): BasinStructure[] {
  const structures: BasinStructure[] = [];
  for (const hub of graph.hubs) {
    const members: number[] = [], weights: number[] = [];
    for (const edge_id of hub.member_edge_ids) {
      const node = graph.source[edge_id]!, weight = graph.weight[edge_id]!;
      if (node < event && weight > 0) { members.push(node); weights.push(weight); }
    }
    if (members.length < 2) continue;
    const total = fsum(weights);
    structures.push({ hub_id: hub.created_event, members, weights,
      normalized: Float64Array.from(weights, weight => weight / total), conductance: -Math.expm1(-total) });
  }
  return structures;
}

function score_active_basins(structures: BasinStructure[], scores: Float64Array): Basin[] {
  return structures.map(structure => {
    const values = structure.members.map(node => scores[node]!);
    const peak = maximum(values);
    const mass = numpy_sum(values.map((value, index) => structure.normalized[index]! * Math.exp(value - peak)));
    return { hub_id: structure.hub_id, score: (peak + Math.log(mass)) * structure.conductance,
      members: structure.members, weights: structure.weights };
  });
}

function pooled_heads(basins: Basin[], fields: Fields, continuation: number, temperature: number): Head[] {
  const positive = basins.filter(basin => basin.score > 0);
  if (!positive.length) return [];
  const peak = maximum(positive.map(basin => basin.score));
  const selection = temperature_sparsemax(Float64Array.from(positive, basin => basin.score / peak), temperature);
  return merge_overlapping_heads(selection.map(([index, mass]) =>
    [positive[index]!, mass, head_seed(positive[index]!, fields, continuation)]));
}

function accessibility_supported_heads(graph: DynamicMemoryGraph, heads: Head[]): Head[] {
  if (heads.length < 2) return heads;
  const hubs = new Map(graph.hubs.map(hub => [hub.created_event, hub.node_id]));
  const accessibility = Float64Array.from(heads, ([id]) => {
    const edges = id.split("+").flatMap(event => graph.hub_members.get(hubs.get(Number(event))!)!);
    return fsum(edges.map(edge => graph.effective_weight(edge))) / fsum(edges.map(edge => graph.weight[edge]!));
  });
  const support = new Set(gain_normalized_sparsemax(accessibility).map(([index]) => index));
  const selected = heads.filter((_, index) => support.has(index));
  const total = fsum(selected.map(([, mass]) => mass));
  return selected.map(([id, mass, seed]) => [id, mass / total, seed]);
}

function head_seed(basin: Basin, fields: Fields, continuation: number): WeightedNodes {
  const peak = maximum(basin.weights);
  const log_prior = basin.weights.map(value => Math.log(value / peak));
  const current = gain_normalized_sparsemax(Float64Array.from(basin.members,
    (node, index) => fields.current![node]! + log_prior[index]!));
  const same_event = gain_normalized_sparsemax(Float64Array.from(basin.members,
    (node, index) => fields.same_event![node]! + log_prior[index]!));
  return mixed_seed(current, same_event, continuation).map(([node, value]) => [basin.members[node]!, value]);
}

function merge_overlapping_heads(heads: SelectedHead[]): Head[] {
  const parent = heads.map((_, index) => index);
  const find = (start: number) => {
    let node = start;
    while (parent[node] !== node) { parent[node] = parent[parent[node]!]!; node = parent[node]!; }
    return node;
  };
  const owners = new Map<number, number>();
  for (const [index, [, , seed]] of heads.entries()) for (const [node] of seed) {
    if (!owners.has(node)) owners.set(node, index);
    const left = find(index), right = find(owners.get(node)!);
    if (left !== right) parent[Math.max(left, right)] = Math.min(left, right);
  }
  const grouped = new Map<number, number[]>();
  for (let index = 0; index < heads.length; index++) {
    const root = find(index);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root)!.push(index);
  }
  const merged: Head[] = [];
  for (const indices of grouped.values()) {
    const mass = fsum(indices.map(index => heads[index]![1]));
    const values = new Map<number, number>(), hub_ids: number[] = [];
    for (const index of indices) {
      const [basin, head_mass, seed] = heads[index]!;
      hub_ids.push(basin.hub_id);
      for (const [node, value] of seed) values.set(node, (values.get(node) ?? 0) + head_mass * value);
    }
    const total = fsum(values.values());
    merged.push([hub_ids.sort((a, b) => a - b).join("+"), mass,
      [...values].sort(([a], [b]) => a - b).map(([node, value]) => [node, value / total])]);
  }
  return merged.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function completion_support(diffusion: DiffusionResult, seed: WeightedNodes, end: number, restart: number): Set<number> {
  const completion = diffusion.reserve.slice(0, end);
  const seed_nodes = new Set(seed.map(([node]) => node));
  for (const [node, value] of seed) completion[node] = Math.max(0, completion[node]! - restart * value);
  const candidates = [...completion.keys()].filter(node => completion[node]! > 0 && !seed_nodes.has(node));
  if (!candidates.length) return new Set();
  return new Set(gain_normalized_sparsemax(Float64Array.from(candidates, node => completion[node]!))
    .map(([index]) => candidates[index]!));
}

function turn_posterior(diffusion: DiffusionResult, end: number): Float64Array {
  const turns = diffusion.reserve.slice(0, end);
  const total = numpy_sum(turns);
  return total === 0 ? turns : turns.map(value => value / total);
}

function relative_tail_entmax15(basin: Float64Array, sharp: Float64Array, temporal: Float64Array,
  direct_nodes: ReadonlySet<number>): WeightedNodes {
  const information = Float64Array.from(basin, (value, node) =>
    value > sharp[node]! ? value * Math.log(2 * value / (value + sharp[node]!)) : 0);
  const peak = maximum(information);
  if (!(peak > 0)) return [];
  const temporal_peak = maximum(temporal);
  if (temporal_peak === 0) return [];
  const score = Float64Array.from(information, (value, node) => Math.sqrt(value / peak * (temporal[node]! / temporal_peak)));
  for (const node of direct_nodes) score[node] = 0;
  const candidates = [...score.keys()].filter(node => score[node]! > 0);
  if (!candidates.length) return [];
  const score_peak = maximum(candidates.map(node => score[node]!));
  return entmax(Float64Array.from(candidates, node => score[node]! / score_peak), 1.5)
    .map(([index, value]) => [candidates[index]!, value]);
}

function shared_tail(evidence: ReadonlyMap<number, number>): Set<number> {
  if (!evidence.size) return new Set();
  const nodes = [...evidence.keys()].sort((a, b) => a - b);
  const peak = maximum(evidence.values());
  return new Set(entmax(Float64Array.from(nodes, node => evidence.get(node)! / peak), 1.75)
    .map(([index]) => nodes[index]!));
}

function cue_agreement(fields: Fields, continuation: number): Float64Array {
  const dense = Float64Array.from(fields.current_dense!, (value, index) => value + continuation * fields.context_dense![index]!);
  const bm25 = Float64Array.from(fields.current_bm25!, (value, index) => value + continuation * fields.context_bm25![index]!);
  const dense_peak = maximum(dense), bm25_peak = maximum(bm25);
  if (dense_peak === 0 || bm25_peak === 0) return new Float64Array(dense.length);
  return Float64Array.from(dense, (value, index) => Math.sqrt(value / dense_peak * (bm25[index]! / bm25_peak)));
}

function filter_tail_by_agreement(nodes: ReadonlySet<number>, evidence: ReadonlyMap<number, number>, agreement: Float64Array): Set<number> {
  const candidates = [...nodes].sort((a, b) => a - b).filter(node => agreement[node]! > 0);
  if (!candidates.length) return new Set();
  const quality = Float64Array.from(candidates, node => evidence.get(node)! * agreement[node]!);
  const peak = maximum(quality);
  return new Set(entmax(quality.map(value => value / peak), 1.90).map(([index]) => candidates[index]!));
}

function surprise_temperature(surprise: number, historical_surprise: Float64Array): number {
  if (!historical_surprise.length) return 1;
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  };
  const center = median([...historical_surprise]);
  const robust_scale = median(Array.from(historical_surprise, value => Math.abs(value - center)));
  if (robust_scale === 0) return surprise === 0 ? 0 : 1;
  return -Math.expm1(-surprise / robust_scale);
}

function temperature_sparsemax(logits: Float64Array, temperature: number): Array<[number, number]> {
  if (temperature !== 0) return sparsemax(logits.map(value => value / temperature));
  const peak = maximum(logits);
  const winners = [...logits.keys()].filter(index => logits[index] === peak);
  return winners.map(node => [node, 1 / winners.length]);
}

function gain_normalized_sparsemax(scores: Float64Array): Array<[number, number]> {
  const peak = maximum(scores);
  return peak <= 0 ? [] : sparsemax(scores.map(value => value / peak));
}

function mixed_seed(current: WeightedNodes, same_event: WeightedNodes, continuation: number): Array<[number, number]> {
  const mixed = new Map<number, number>();
  for (const [node, value] of current) mixed.set(node, (mixed.get(node) ?? 0) + (1 - continuation) * value);
  for (const [node, value] of same_event) mixed.set(node, (mixed.get(node) ?? 0) + continuation * value);
  const total = fsum(mixed.values());
  return total === 0 ? [] : [...mixed].sort(([a], [b]) => a - b).filter(([, value]) => value > 0)
    .map(([node, value]) => [node, value / total]);
}
