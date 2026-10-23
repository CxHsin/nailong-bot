// Ported from akashic-agent 94027a5c, MIT, Copyright (c) 2026 kachofugetsu09.
// Full license notice is in ./LICENSE.
import { MemoryConfig, type DiffusionResult, type PlasticityResult, type SeedEvidence, type WeightedNodes } from "./model.js";
import { dot, entmax, erfc, fsum } from "./numeric.js";

export const MEMBERSHIP = 0, TEMPORAL_FORWARD = 1, TEMPORAL_BACKWARD = 2;
export interface HubRecord {
  node_id: number; created_event: number; current_turn_id: number;
  threshold: number; innovation_mass: number; member_edge_ids: number[];
}
export interface RetrievalState {
  elapsed_seconds: number; short_log_gap: number | null; long_log_gap: number | null;
  short_gap_count: number; long_gap_count: number;
  short_recurrence_log_gap: number | null; long_recurrence_log_gap: number | null;
  short_recurrence_log_m2: number; long_recurrence_log_m2: number;
  short_recurrence_weight: number; long_recurrence_weight: number;
  recurrence_log_mean: number | null; recurrence_log_m2: number; recurrence_weight: number;
  last_external_seed_seconds: Array<[number, number]>; current_external: Array<[number, number]>; current_event: number;
}
export const EDGE_FIELDS = ["source", "target", "kind", "weight", "last_updated", "created_event", "observed_credit",
  "recurrent_credit", "resource", "plasticity_threshold", "last_stimulated_seconds", "last_support_seconds",
  "support_credit", "independent_credit"] as const;
export interface GraphSnapshot {
  turn_count: number; max_nodes: number; columns: Record<typeof EDGE_FIELDS[number], number[]>;
  bidirectional: boolean[]; adjacency: number[][]; hubs: HubRecord[];
  hub_members: Record<string, number[]>; temporal_lookup: number[][]; state: RetrievalState;
}

export class DynamicMemoryGraph {
  max_nodes: number;
  adjacency: number[][];
  source: number[] = []; target: number[] = []; kind: number[] = []; bidirectional: boolean[] = [];
  weight: number[] = []; last_updated: number[] = []; created_event: number[] = [];
  observed_credit: number[] = []; recurrent_credit: number[] = []; resource: number[] = [];
  plasticity_threshold: number[] = []; last_stimulated_seconds: number[] = []; last_support_seconds: number[] = [];
  support_credit: number[] = []; independent_credit: number[] = [];
  hubs: HubRecord[] = []; hub_members = new Map<number, number[]>(); temporal_lookup = new Map<string, number>();
  elapsed_seconds = 0; short_log_gap: number | null = null; long_log_gap: number | null = null;
  short_gap_count = 0; long_gap_count = 0;
  short_recurrence_log_gap: number | null = null; long_recurrence_log_gap: number | null = null;
  short_recurrence_log_m2 = 0; long_recurrence_log_m2 = 0; short_recurrence_weight = 0; long_recurrence_weight = 0;
  recurrence_log_mean: number | null = null; recurrence_log_m2 = 0; recurrence_weight = 0;
  last_external_seed_seconds = new Map<number, number>(); current_external = new Map<number, number>(); current_event = -1;
  private transition_cache = new Map<number, [Array<[number, number, number]>, number]>();

  constructor(public turn_count: number, public config: MemoryConfig) {
    config.validate(); this.max_nodes = turn_count * 2; this.adjacency = Array.from({ length: this.max_nodes }, () => []);
  }

  grow_turn_capacity(count: number): void {
    if (count < this.turn_count) throw new Error("memory graph turn capacity cannot shrink");
    if (count === this.turn_count) return;
    const old = this.turn_count, offset = count - old, remap = (node: number) => node >= old ? node + offset : node;
    this.transition_cache.clear();
    this.source = this.source.map(remap); this.target = this.target.map(remap);
    this.hubs = this.hubs.map(hub => ({ ...hub, node_id: remap(hub.node_id) }));
    this.hub_members = new Map([...this.hub_members].map(([node, edges]) => [remap(node), edges]));
    this.adjacency = [...this.adjacency.slice(0, old), ...Array.from({ length: offset }, () => []),
      ...this.adjacency.slice(old, old * 2), ...Array.from({ length: offset }, () => [])];
    this.turn_count = count; this.max_nodes = count * 2;
  }

  temporary_turn_capacity<T>(count: number, operation: () => T): T {
    const prior = { turn_count: this.turn_count, max_nodes: this.max_nodes, source: this.source, target: this.target,
      hubs: this.hubs, hub_members: this.hub_members, adjacency: this.adjacency };
    try { this.grow_turn_capacity(count); return operation(); }
    finally { Object.assign(this, prior); this.transition_cache.clear(); }
  }

  capture_retrieval_state(): RetrievalState {
    return { elapsed_seconds: this.elapsed_seconds, short_log_gap: this.short_log_gap, long_log_gap: this.long_log_gap,
      short_gap_count: this.short_gap_count, long_gap_count: this.long_gap_count,
      short_recurrence_log_gap: this.short_recurrence_log_gap, long_recurrence_log_gap: this.long_recurrence_log_gap,
      short_recurrence_log_m2: this.short_recurrence_log_m2, long_recurrence_log_m2: this.long_recurrence_log_m2,
      short_recurrence_weight: this.short_recurrence_weight, long_recurrence_weight: this.long_recurrence_weight,
      recurrence_log_mean: this.recurrence_log_mean, recurrence_log_m2: this.recurrence_log_m2, recurrence_weight: this.recurrence_weight,
      last_external_seed_seconds: [...this.last_external_seed_seconds].sort(([a], [b]) => a - b),
      current_external: [...this.current_external].sort(([a], [b]) => a - b), current_event: this.current_event };
  }

  apply_retrieval_state(state: RetrievalState): void {
    const { last_external_seed_seconds, current_external, ...fields } = state;
    Object.assign(this, fields);
    this.last_external_seed_seconds = new Map(last_external_seed_seconds);
    this.current_external = new Map(current_external); this.transition_cache.clear();
  }

  get resource_tau_seconds(): number {
    return this.short_log_gap === null ? 1 : this.long_log_gap === null ? Math.exp(this.short_log_gap)
      : Math.exp((this.short_log_gap + this.long_log_gap) / 2);
  }
  get threshold_tau_seconds(): number { return Math.exp(this.long_log_gap ?? this.short_log_gap ?? 0); }
  get short_recurrence_tau_seconds(): number {
    return this.short_recurrence_log_gap === null ? this.threshold_tau_seconds : Math.exp(this.short_recurrence_log_gap);
  }
  get long_recurrence_tau_seconds(): number {
    return this.long_recurrence_log_gap === null ? this.short_recurrence_tau_seconds : Math.exp(this.long_recurrence_log_gap);
  }
  get retention_tau_seconds(): number { return Math.max(this.threshold_tau_seconds, this.long_recurrence_tau_seconds); }

  prepare_retrieval(event: number, gapSeconds: number | null, evidence: SeedEvidence): void {
    if (event !== this.current_event + 1) throw new Error("memory events must be prepared in causal order");
    if (gapSeconds !== null && gapSeconds < 0) throw new Error("memory event gap cannot be negative");
    this.current_event = event; const gap = gapSeconds ?? 0; this.elapsed_seconds += gap; this.observe_gap(gap); this.transition_cache.clear();
    const direct = new Set([...(evidence.channels.query_dense ?? []), ...(evidence.channels.query_bm25 ?? [])]);
    const seed = new Map(evidence.seed);
    this.current_external = new Map([...direct].sort((a, b) => a - b).filter(node => (seed.get(node) ?? 0) > 0).map(node => [node, seed.get(node)!]));
    this.current_external.set(event, 1);
    for (const [node, credit] of this.current_external) {
      if (node === event) continue;
      const previous = this.last_external_seed_seconds.get(node);
      if (previous !== undefined) this.observe_recurrence(this.elapsed_seconds - previous, credit);
      this.last_external_seed_seconds.set(node, this.elapsed_seconds);
    }
  }

  transitions(node: number, event: number): [Array<[number, number, number]>, number] {
    if (event < this.current_event) throw new Error("relation state cannot move backwards in time");
    const cached = this.transition_cache.get(node); if (cached) return cached;
    const weighted: Array<[number, number, number]> = [];
    for (const edge of this.adjacency[node]!) {
      const weight = this.effective_weight(edge); if (weight <= 0) continue;
      const target = this._outgoing_target(edge, node); if (target !== null) weighted.push([target, weight, edge]);
    }
    const total = fsum(weighted.map(([, value]) => value));
    const spread = -Math.expm1(-total);
    const result: [Array<[number, number, number]>, number] = total === 0 ? [[], 1]
      : [weighted.map(([target, value, edge]) => [target, spread * value / total, edge]), 1 - spread];
    this.transition_cache.set(node, result); return result;
  }

  apply_feedback_inhibition(inhibited: ReadonlySet<number>): void { for (const node of inhibited) this.current_external.delete(node); }
  reinforce_feedback_nodes(nodes: readonly number[], boost: number): void {
    if (boost === 1) return;
    const own = new Map(this.hubs.filter(hub => nodes.includes(hub.created_event)).map(hub => [hub.created_event, hub]));
    const gain = boost ** this.config.learning_rate, credit = Math.log(gain);
    const affectedHubs = new Set<number>(), affectedSources = new Set<number>(); this.transition_cache.clear();
    for (const node of [...nodes].sort((a, b) => a - b)) {
      const hub = own.get(node); if (!hub) continue;
      const edges = hub.member_edge_ids.filter(edge => this.source[edge] === node);
      if (edges.length !== 1) throw new Error("own episode must contain exactly one target membership");
      const edge = edges[0]!; this.weight[edge] = Math.min(1, this.weight[edge]! * gain); this.last_updated[edge] = this.current_event;
      this.support_edge(edge, credit, credit); affectedHubs.add(this.target[edge]!); affectedSources.add(node);
    }
    for (const hub of [...affectedHubs].sort((a, b) => a - b)) this.normalize_hub(hub);
    for (const node of [...affectedSources].sort((a, b) => a - b)) this.normalize_membership_source(node);
  }

  learn(event: number, evidence: SeedEvidence, diffusion: DiffusionResult): PlasticityResult {
    this.transition_cache.clear(); const [observed, activity] = this.event_activity(event, evidence, diffusion);
    const nodes = [...activity.keys()].filter(node => node < this.turn_count && activity[node]! > 0), values = nodes.map(node => activity[node]!);
    const threshold = dot(values, values) / fsum(values), integrated = this.integrated_members(nodes, activity);
    const [hubPositive, hubNegative] = this.adapt_exposed_hubs(event, observed, activity);
    const [temporalPositive, temporalNegative] = this.adapt_temporal_relations(event, observed, activity);
    const reactivated = hubPositive + temporalPositive;
    const [hub, hubWritten] = this.create_hub(event, integrated, observed, threshold, evidence.surprise);
    const temporalWritten = this.update_temporal(event, integrated, observed, evidence.continuation, evidence.surprise);
    return { hub_node_id: hub, threshold, integrated, inhibited_mass: hubNegative + temporalNegative,
      potentiated_mass: reactivated + hubWritten + temporalWritten,
      observed_mass: fsum(nodes.filter(node => observed[node]).map(node => activity[node]!)),
      recurrent_mass: fsum(nodes.filter(node => !observed[node]).map(node => activity[node]!)),
      reactivated_mass: reactivated, pushes: 0, residual_l1: 0 };
  }
  edge_relation_name(edge: number): string { return ["episode", "temporal_forward", "temporal_backward"][this.kind[edge]!]!; }
  retention_factor(edge: number): number {
    if (!this.config.forgetting_enabled) return 1;
    const age = this.elapsed_seconds - this.last_support_seconds[edge]!;
    if (age < 0) throw new Error("retention state cannot move backwards in time");
    return this.recurrence_survival(age);
  }
  recurrence_survival(age: number): number {
    if (age <= 0 || this.recurrence_log_m2 === 0) return 1;
    const total = this.short_recurrence_weight + this.long_recurrence_weight;
    if (total === 0) return 1;
    const logAge = Math.log(age), pooledSigma = Math.sqrt(this.recurrence_log_m2 / this.recurrence_weight);
    let survival = 0;
    for (const [mean, m2, weight] of [[this.short_recurrence_log_gap, this.short_recurrence_log_m2, this.short_recurrence_weight],
      [this.long_recurrence_log_gap, this.long_recurrence_log_m2, this.long_recurrence_weight]] as const) {
      if (mean === null || weight === 0) continue;
      const sigma = m2 > 0 ? Math.sqrt(m2 / weight) : pooledSigma;
      const component = sigma === 0 ? Number(logAge < mean) : 0.5 * erfc((logAge - mean) / (Math.SQRT2 * sigma));
      survival += weight * component / total;
    }
    return survival;
  }
  effective_weight(edge: number): number { return this.weight[edge]! * this.retention_factor(edge); }

  private event_activity(event: number, evidence: SeedEvidence, diffusion: DiffusionResult): [boolean[], Float64Array] {
    const observed = Array<boolean>(this.max_nodes).fill(false), activity = new Float64Array(this.max_nodes);
    observed[event] = true; activity[event] = 1;
    for (const [node, value] of evidence.seed) { observed[node] = true; activity[node] = Math.max(activity[node]!, value); }
    const active = Array.from(diffusion.active_nodes), peak = active.length ? Math.max(...active.map(node => diffusion.reserve[node]!)) : 1;
    if (peak > 0) for (const node of active) activity[node] = Math.max(activity[node]!, diffusion.reserve[node]! / peak);
    return [observed, activity];
  }
  private integrated_members(nodes: number[], activity: Float64Array): Array<[number, number]> {
    const scale = Math.log1p(nodes.length), powered = nodes.map(node => activity[node]! ** this.config.activation_power * scale);
    return entmax(powered, 1.5).map(([index, value]) => [nodes[index]!, value]);
  }
  private adapt_exposed_hubs(event: number, observed: boolean[], activity: Float64Array): [number, number] {
    const exposed = new Set<number>();
    for (let node = 0; node < this.turn_count; node++) if (activity[node]! > 0)
      for (const edge of this.adjacency[node]!) if (this.kind[edge] === MEMBERSHIP) exposed.add(this.target[edge]!);
    let potentiated = 0, inhibited = 0; const affected = new Set<number>();
    for (const hub of [...exposed].sort((a, b) => a - b)) {
      const edges = this.hub_members.get(hub)!;
      const hubActivity = fsum(edges.map(edge => this.effective_weight(edge) * activity[this.source[edge]!]!));
      if (hubActivity === 0) continue;
      const externalTotal = fsum(edges.map(edge => this.current_external.get(this.source[edge]!) ?? 0));
      for (const edge of edges) {
        const old = this.weight[edge]!, member = this.source[edge]!, memberActivity = activity[member]!;
        const [eligibility] = this.stimulate_edge(edge, hubActivity);
        const updated = Math.max(0, old + this.config.learning_rate * eligibility * hubActivity * (memberActivity - hubActivity * old));
        this.weight[edge] = updated; this.last_updated[edge] = event;
        potentiated += Math.max(updated - old, 0); inhibited += Math.max(old - updated, 0);
        if (memberActivity > 0) {
          if (observed[member]) this.observed_credit[edge] = this.observed_credit[edge]! + memberActivity;
          else this.recurrent_credit[edge] = this.recurrent_credit[edge]! + memberActivity;
        }
        const external = this.current_external.get(member) ?? 0;
        this.support_edge(edge, Math.sqrt(memberActivity * hubActivity), Math.sqrt(external * Math.max(0, externalTotal - external)));
        affected.add(member);
      }
      inhibited += this.normalize_hub(hub);
    }
    for (const member of [...affected].sort((a, b) => a - b)) inhibited += this.normalize_membership_source(member);
    return [potentiated, inhibited];
  }
  private adapt_temporal_relations(event: number, observed: boolean[], activity: Float64Array): [number, number] {
    const selected = new Set<number>();
    for (let node = 0; node < this.turn_count; node++) if (activity[node]! > 0)
      for (const edge of this.adjacency[node]!) if (this.kind[edge] !== MEMBERSHIP) selected.add(edge);
    let potentiated = 0, inhibited = 0; const affected = new Set<string>();
    for (const edge of [...selected].sort((a, b) => a - b)) {
      const source = this.source[edge]!, target = this.target[edge]!, sourceActivity = activity[source]!;
      if (sourceActivity === 0) continue;
      const old = this.weight[edge]!, targetActivity = activity[target]!, [eligibility] = this.stimulate_edge(edge, sourceActivity);
      const updated = Math.max(0, old + this.config.learning_rate * eligibility * sourceActivity * (targetActivity - sourceActivity * old));
      this.weight[edge] = updated; this.last_updated[edge] = event;
      potentiated += Math.max(updated - old, 0); inhibited += Math.max(old - updated, 0);
      const credit = sourceActivity * targetActivity;
      if (observed[source] && observed[target]) this.observed_credit[edge] = this.observed_credit[edge]! + credit;
      else this.recurrent_credit[edge] = this.recurrent_credit[edge]! + credit;
      const independent = Math.sqrt((this.current_external.get(source) ?? 0) * (this.current_external.get(target) ?? 0));
      this.support_edge(edge, Math.sqrt(sourceActivity * targetActivity), independent);
      affected.add(`${source},${this.kind[edge]}`);
    }
    for (const key of [...affected].map(key => key.split(",").map(Number)).sort(([a, b], [c, d]) => a! - c! || b! - d!))
      inhibited += this.normalize_temporal_source(key[0]!, key[1]!);
    return [potentiated, inhibited];
  }
  private create_hub(event: number, integrated: WeightedNodes, observed: boolean[], threshold: number, gain: number): [number | null, number] {
    if (integrated.length < 2 || gain <= 0) return [null, 0];
    const values = integrated.map(([node, weight]) => [node, weight * gain] as const), total = fsum(values.map(([, value]) => value));
    const scale = Math.min(1, this.config.recurrent_budget / total), hub = this.turn_count + event, edges: number[] = [];
    const externalTotal = fsum(values.map(([node]) => this.current_external.get(node) ?? 0)), integratedMap = new Map(integrated);
    for (const [node, value] of values) {
      const weighted = value * scale, external = this.current_external.get(node) ?? 0, activity = integratedMap.get(node)!;
      edges.push(this.add_edge(node, hub, MEMBERSHIP, true, event, weighted, observed[node] ? weighted : 0,
        observed[node] ? 0 : weighted, gain * Math.sqrt(activity * Math.max(0, 1 - activity)),
        gain * Math.sqrt(external * Math.max(0, externalTotal - external))));
    }
    this.hub_members.set(hub, edges);
    for (const [node] of values) this.normalize_membership_source(node);
    const innovation = fsum(edges.map(edge => this.weight[edge]!));
    this.hubs.push({ node_id: hub, created_event: event, current_turn_id: event, threshold, innovation_mass: innovation, member_edge_ids: edges });
    return [hub, innovation];
  }
  private update_temporal(event: number, integrated: WeightedNodes, observed: boolean[], continuation: number, gain: number): number {
    const past = integrated.filter(([node]) => node !== event), total = fsum(past.map(([, weight]) => weight));
    if (total === 0 || gain <= 0) return 0;
    let written = 0; const affected = new Set<string>();
    for (const [node, weight] of past) {
      const forward = continuation * gain * weight / total, reverse = this.config.reverse_temporal_ratio * forward;
      written += this.upsert_temporal(TEMPORAL_FORWARD, node, event, event, forward, observed[node]!);
      written += this.upsert_temporal(TEMPORAL_BACKWARD, event, node, event, reverse, observed[node]!);
      affected.add(`${node},${TEMPORAL_FORWARD}`); affected.add(`${event},${TEMPORAL_BACKWARD}`);
    }
    for (const pair of [...affected].map(key => key.split(",").map(Number)).sort(([a, b], [c, d]) => a! - c! || b! - d!))
      this.normalize_temporal_source(pair[0]!, pair[1]!);
    return written;
  }
  private upsert_temporal(kind: number, source: number, target: number, event: number, signal: number, observed: boolean): number {
    const key = `${kind},${source},${target}`, existing = this.temporal_lookup.get(key);
    const independent = Math.sqrt((this.current_external.get(source) ?? 0) * (this.current_external.get(target) ?? 0));
    if (existing === undefined) {
      const edge = this.add_edge(source, target, kind, false, event, signal, observed ? signal : 0, observed ? 0 : signal, signal, independent);
      this.temporal_lookup.set(key, edge); return signal;
    }
    const old = this.weight[existing]!;
    this.weight[existing] = Math.min(1, old + this.config.learning_rate * signal * (1 - old)); this.last_updated[existing] = event;
    if (observed) this.observed_credit[existing] = this.observed_credit[existing]! + signal;
    else this.recurrent_credit[existing] = this.recurrent_credit[existing]! + signal;
    this.support_edge(existing, signal, independent); return this.weight[existing]! - old;
  }
  private normalize_edges(edges: number[], budget: number): number {
    const total = fsum(edges.map(edge => this.weight[edge]!)); if (total <= budget) return 0;
    const scale = budget / total; let inhibited = 0;
    for (const edge of edges) { const old = this.weight[edge]!; this.weight[edge] = old * scale; inhibited += old - this.weight[edge]!; }
    return inhibited;
  }
  private normalize_hub(hub: number): number { return this.normalize_edges(this.hub_members.get(hub)!, this.config.recurrent_budget); }
  private normalize_membership_source(source: number): number {
    return this.normalize_edges(this.adjacency[source]!.filter(edge => this.kind[edge] === MEMBERSHIP && this.source[edge] === source), this.config.recurrent_budget);
  }
  private normalize_temporal_source(source: number, kind: number): number {
    return this.normalize_edges(this.adjacency[source]!.filter(edge => this.kind[edge] === kind),
      kind === TEMPORAL_FORWARD ? this.config.recurrent_budget : this.config.reverse_temporal_ratio * this.config.recurrent_budget);
  }
  _outgoing_target(edge: number, node: number): number | null {
    if (this.bidirectional[edge]) {
      if (this.source[edge] === node) return this.target[edge]!;
      if (this.target[edge] === node) return this.source[edge]!;
      throw new Error("membership adjacency is inconsistent");
    }
    return this.source[edge] === node ? this.target[edge]! : null;
  }
  private add_edge(source: number, target: number, kind: number, bidirectional: boolean, event: number, weight: number,
    observed: number, recurrent: number, support = 0, independent = 0): number {
    const edge = this.source.length, activity = Math.max(0, weight);
    this.source.push(source); this.target.push(target); this.kind.push(kind); this.bidirectional.push(bidirectional);
    this.weight.push(activity); this.last_updated.push(event); this.created_event.push(event);
    this.observed_credit.push(observed); this.recurrent_credit.push(recurrent); this.resource.push(Math.exp(-activity));
    this.plasticity_threshold.push(-Math.expm1(-(activity * activity)));
    this.last_stimulated_seconds.push(this.elapsed_seconds); this.last_support_seconds.push(this.elapsed_seconds);
    this.support_credit.push(support); this.independent_credit.push(independent);
    this.adjacency[source]!.push(edge); if (bidirectional) this.adjacency[target]!.push(edge); return edge;
  }
  private observe_recurrence(gap: number, credit: number): void {
    if (gap <= 0 || credit <= 0) return; const value = Math.log(gap);
    if (this.recurrence_log_mean === null) { this.recurrence_log_mean = value; this.recurrence_weight = credit; }
    else {
      const total = this.recurrence_weight + credit, delta = value - this.recurrence_log_mean;
      this.recurrence_log_mean += credit * delta / total;
      this.recurrence_log_m2 += credit * delta * (value - this.recurrence_log_mean); this.recurrence_weight = total;
    }
    if (this.short_recurrence_log_gap === null) { this.short_recurrence_log_gap = value; this.short_recurrence_weight = credit; return; }
    if (this.long_recurrence_log_gap === null) {
      if (value < this.short_recurrence_log_gap) {
        this.long_recurrence_log_gap = this.short_recurrence_log_gap; this.long_recurrence_log_m2 = this.short_recurrence_log_m2;
        this.long_recurrence_weight = this.short_recurrence_weight;
        this.short_recurrence_log_gap = value; this.short_recurrence_log_m2 = 0; this.short_recurrence_weight = credit;
      } else { this.long_recurrence_log_gap = value; this.long_recurrence_weight = credit; }
      return;
    }
    if (Math.abs(value - this.short_recurrence_log_gap) <= Math.abs(value - this.long_recurrence_log_gap)) {
      const total = this.short_recurrence_weight + credit, delta = value - this.short_recurrence_log_gap;
      this.short_recurrence_log_gap += credit * delta / total;
      this.short_recurrence_log_m2 += credit * delta * (value - this.short_recurrence_log_gap); this.short_recurrence_weight = total;
    } else {
      const total = this.long_recurrence_weight + credit, delta = value - this.long_recurrence_log_gap;
      this.long_recurrence_log_gap += credit * delta / total;
      this.long_recurrence_log_m2 += credit * delta * (value - this.long_recurrence_log_gap); this.long_recurrence_weight = total;
    }
    if (this.short_recurrence_log_gap > this.long_recurrence_log_gap) {
      [this.short_recurrence_log_gap, this.long_recurrence_log_gap] = [this.long_recurrence_log_gap, this.short_recurrence_log_gap];
      [this.short_recurrence_log_m2, this.long_recurrence_log_m2] = [this.long_recurrence_log_m2, this.short_recurrence_log_m2];
      [this.short_recurrence_weight, this.long_recurrence_weight] = [this.long_recurrence_weight, this.short_recurrence_weight];
    }
  }
  private support_edge(edge: number, credit: number, independent: number): void {
    if (credit <= 0) return;
    const previous = this.last_support_seconds[edge]!, spacing = this.elapsed_seconds - previous;
    if (spacing < 0) throw new Error("relation support cannot move backwards in time");
    this.last_support_seconds[edge] = previous + -Math.expm1(-credit) * spacing;
    this.support_credit[edge] = this.support_credit[edge]! + credit;
    this.independent_credit[edge] = this.independent_credit[edge]! + independent;
  }
  private observe_gap(gap: number): void {
    if (gap <= 0) return; const value = Math.log(gap);
    if (this.short_log_gap === null) { this.short_log_gap = value; this.short_gap_count = 1; return; }
    if (this.long_log_gap === null) {
      if (value < this.short_log_gap) {
        this.long_log_gap = this.short_log_gap; this.long_gap_count = this.short_gap_count; this.short_log_gap = value; this.short_gap_count = 1;
      } else { this.long_log_gap = value; this.long_gap_count = 1; } return;
    }
    if (Math.abs(value - this.short_log_gap) <= Math.abs(value - this.long_log_gap)) {
      this.short_gap_count++; this.short_log_gap += (value - this.short_log_gap) / this.short_gap_count;
    } else { this.long_gap_count++; this.long_log_gap += (value - this.long_log_gap) / this.long_gap_count; }
    if (this.short_log_gap > this.long_log_gap) {
      [this.short_log_gap, this.long_log_gap] = [this.long_log_gap, this.short_log_gap];
      [this.short_gap_count, this.long_gap_count] = [this.long_gap_count, this.short_gap_count];
    }
  }
  private stimulate_edge(edge: number, activity: number): [number, number] {
    let resource = this.resource[edge]!, threshold = this.plasticity_threshold[edge]!;
    const last = this.last_stimulated_seconds[edge]!;
    if (Number.isFinite(last)) {
      const elapsed = this.elapsed_seconds - last;
      if (elapsed < 0) throw new Error("plasticity state cannot move backwards in time");
      resource = 1 - (1 - resource) * Math.exp(-elapsed / this.resource_tau_seconds);
      threshold *= Math.exp(-elapsed / this.threshold_tau_seconds);
    }
    const eligibility = resource * -Math.expm1(-(activity * Math.max(activity - threshold, 0)));
    this.resource[edge] = resource * Math.exp(-activity);
    this.plasticity_threshold[edge] = threshold + (1 - threshold) * -Math.expm1(-(activity * activity));
    this.last_stimulated_seconds[edge] = this.elapsed_seconds; return [eligibility, threshold];
  }

  serialize(): GraphSnapshot {
    return { turn_count: this.turn_count, max_nodes: this.max_nodes,
      columns: Object.fromEntries(EDGE_FIELDS.map(name => [name, [...this[name]]])) as GraphSnapshot["columns"],
      bidirectional: [...this.bidirectional], adjacency: this.adjacency.map(edges => [...edges]),
      hubs: this.hubs.map(hub => ({ ...hub, member_edge_ids: [...hub.member_edge_ids] })),
      hub_members: Object.fromEntries([...this.hub_members].map(([node, edges]) => [node, [...edges]])),
      temporal_lookup: [...this.temporal_lookup].map(([key, value]) => [...key.split(",").map(Number), value])
        .sort(([a, b, c], [d, e, f]) => a! - d! || b! - e! || c! - f!), state: this.capture_retrieval_state() };
  }
  static restore(snapshot: GraphSnapshot, config = new MemoryConfig()): DynamicMemoryGraph {
    const graph = new DynamicMemoryGraph(snapshot.turn_count, config);
    for (const name of EDGE_FIELDS) graph[name] = [...snapshot.columns[name]];
    graph.bidirectional = [...snapshot.bidirectional]; graph.adjacency = snapshot.adjacency.map(edges => [...edges]);
    graph.hubs = snapshot.hubs.map(hub => ({ ...hub, member_edge_ids: [...hub.member_edge_ids] }));
    graph.hub_members = new Map(Object.entries(snapshot.hub_members).map(([node, edges]) => [Number(node), [...edges]]));
    graph.temporal_lookup = new Map(snapshot.temporal_lookup.map(([kind, source, target, edge]) => [`${kind},${source},${target}`, edge!]));
    graph.apply_retrieval_state(snapshot.state); return graph;
  }
}
