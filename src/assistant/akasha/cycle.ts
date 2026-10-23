// Ported from akashic-agent 94027a5c, MIT, Copyright (c) 2026 kachofugetsu09.
// Full license notice is in ./LICENSE.
import { residual_push } from "./diffusion.js";
import { BurstAwareFeaturePool, type BurstDecision } from "./features.js";
import { DynamicMemoryGraph, type GraphSnapshot, type RetrievalState } from "./graph.js";
import { MemoryConfig, type ContextState, type DiffusionResult, type PlasticityResult, type SeedEvidence, type Turn, type TurnFeedback } from "./model.js";
import { read_pattern_completion, type PatternCompletion, type RecallCapture } from "./readout.js";

export interface RetrievalTicket {
  state_version: number; previous_turn_capacity: number; turn_id: string; cue_text: string; cue_started_at: string;
  completion_evaluated: boolean; burst_decision: BurstDecision; evidence: SeedEvidence;
  diffusion: DiffusionResult; completion: PatternCompletion; prepared_turn_capacity: number; prepared_state: RetrievalState;
}
export interface CycleCommit { event: PlasticityResult; evidence: SeedEvidence; diffusion: DiffusionResult; retrieval_recomputed: boolean }
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type TicketSnapshot = { [key: string]: JsonValue };
export interface CycleSnapshot {
  config: Omit<MemoryConfig, "validate">; turns: Array<{ [key: string]: JsonValue }>;
  graph: GraphSnapshot; context: JsonValue;
  events: PlasticityResult[]; evidence: TicketSnapshot[]; recalls: RecallCapture[];
  burst_members: Record<string, number[]>; inhibited_nodes: number[];
}

function plain(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return value;
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (value instanceof Set) return [...value].sort((a: number, b: number) => a - b);
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]));
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, plain(item)]));
}
function clone<T>(value: T): T { return structuredClone(value); }
function restoreContext(value: ContextState): ContextState {
  return { members: value.members.map(pair => [...pair] as [number, number]),
    dense: value.dense === null ? null : Float64Array.from(value.dense), terms: value.terms.map(pair => [...pair] as [string, number]) };
}
function restoreEvidence(value: SeedEvidence): SeedEvidence {
  return { ...value, seed: value.seed.map(pair => [...pair] as [number, number]),
    channels: Object.fromEntries(Object.entries(value.channels).map(([key, nodes]) => [key, new Set(nodes)])) };
}
function restoreDiffusion(value: DiffusionResult): DiffusionResult {
  return { ...value, reserve: Float64Array.from(value.reserve), active_nodes: Int32Array.from(value.active_nodes),
    parent_node: value.parent_node === null ? null : Int32Array.from(value.parent_node),
    parent_edge: value.parent_edge === null ? null : Int32Array.from(value.parent_edge) };
}
export function serializeTicket(ticket: RetrievalTicket): TicketSnapshot { return plain(ticket) as TicketSnapshot; }
export function restoreTicket(value: TicketSnapshot): RetrievalTicket {
  const ticket = clone(value) as unknown as RetrievalTicket;
  ticket.evidence = restoreEvidence(ticket.evidence);
  ticket.diffusion = restoreDiffusion(ticket.diffusion);
  ticket.burst_decision = { ...ticket.burst_decision,
    evidence: restoreEvidence(ticket.burst_decision.evidence), context: restoreContext(ticket.burst_decision.context),
    fields: Object.fromEntries(Object.entries(ticket.burst_decision.fields).map(([key, field]) => [key, Float64Array.from(field)])) };
  return ticket;
}

function validateFeedback(feedback: TurnFeedback, event: number): void {
  if (feedback.remember_nodes.some(node => feedback.forget_nodes.includes(node))) throw new Error("remember and forget targets cannot overlap");
  if (feedback.remember_nodes.some(node => node < 0 || node > event)) throw new Error("remember targets must be causally available");
  if (feedback.forget_nodes.some(node => node < 0 || node >= event)) throw new Error("forget targets must be historical");
  if (!(feedback.remember_boost >= 1 && feedback.remember_boost <= 3)) throw new Error("remember boost must be in [1, 3]");
}
function learningEvidence(evidence: SeedEvidence): SeedEvidence {
  const nodes = new Set(evidence.seed.map(([node]) => node));
  return { ...evidence, channels: Object.fromEntries(Object.entries(evidence.channels)
    .map(([name, members]) => [name, new Set([...members].filter(node => nodes.has(node)))])) };
}
function emptyCompletion(diffusion: DiffusionResult): PatternCompletion {
  return { items: [], active_basin_count: 0, sharp_completion_count: 0, basin_direct_count: 0,
    basin_completion_count: 0, relative_tail_count: 0, pushes: diffusion.pushes, residual_l1: diffusion.residual_l1 };
}

export class MemoryCycle {
  turns: Turn[] = [];
  graph: DynamicMemoryGraph;
  feature_pool: BurstAwareFeaturePool | null;
  context: ContextState | null = null;
  events: PlasticityResult[] = [];
  evidence: SeedEvidence[] = [];
  recalls: RecallCapture[] = [];
  burst_members = new Map<string, number[]>();
  inhibited_nodes = new Set<number>();
  constructor(public config = new MemoryConfig(), options: { turn_capacity?: number; feature_pool?: BurstAwareFeaturePool } = {}) {
    config.validate(); const capacity = options.turn_capacity ?? 0;
    if (capacity < 0) throw new Error("turn capacity cannot be negative");
    if (options.feature_pool && options.feature_pool.turns.length !== capacity) throw new Error("feature pool must span complete turn capacity");
    this.graph = new DynamicMemoryGraph(capacity, config); this.feature_pool = options.feature_pool ?? null;
  }
  get state_version(): number { return this.turns.length; }

  retrieve(turn: Turn, options: { capture_paths?: boolean; include_completion?: boolean } = {}): RetrievalTicket {
    const event = this.state_version;
    if (turn.node_id !== event) throw new Error(`query turn node_id must be ${event}, got ${turn.node_id}`);
    const capture = options.capture_paths ?? false, include = options.include_completion ?? true;
    const pool = this.retrieval_pool(turn), decision = this.burst_decision(pool, turn, capture), evidence = decision.evidence;
    const previousCapacity = this.graph.turn_count, published = this.graph.capture_retrieval_state();
    return this.graph.temporary_turn_capacity(Math.max(event + 1, previousCapacity), () => {
      try {
        this.graph.prepare_retrieval(event, turn.inter_gap_seconds, evidence);
        const preparedCapacity = this.graph.turn_count, preparedState = this.graph.capture_retrieval_state();
        const diffusion = residual_push(this.graph, evidence.seed, event,
          { restart: this.config.restart, tolerance: this.config.tolerance, capture_paths: capture });
        const completion = event === 0 || !include ? emptyCompletion(diffusion) : read_pattern_completion({ graph: this.graph,
          pool, query: turn, context: decision.context, precomputed_fields: decision.fields, evidence, diffusion,
          historical_surprise: Float64Array.from(this.evidence.map(item => item.surprise)), config: this.config,
          context_dependence: decision.context_dependence, visible_nodes: decision.visible_nodes,
          burst_continued: decision.continued, inhibited_nodes: this.inhibited_nodes });
        return { state_version: event, previous_turn_capacity: previousCapacity, turn_id: turn.turn_id,
          cue_text: turn.user_text, cue_started_at: turn.started_at, completion_evaluated: include,
          burst_decision: decision, evidence, diffusion, completion, prepared_turn_capacity: preparedCapacity, prepared_state: preparedState };
      } finally { this.graph.apply_retrieval_state(published); }
    });
  }

  commit(turn: Turn, ticket: RetrievalTicket | null): CycleCommit {
    const recomputed = ticket === null || ticket.state_version !== this.state_version;
    const causal = recomputed ? { ...turn, node_id: this.state_version } : turn;
    const selected = recomputed ? this.retrieve(causal) : ticket!;
    if (selected.turn_id !== turn.turn_id) throw new Error("retrieval ticket turn identity does not match committed turn");
    if (selected.prepared_turn_capacity < this.graph.turn_count) throw new Error("committed memory cycle cannot shrink capacity");
    this.graph.grow_turn_capacity(selected.prepared_turn_capacity); this.graph.apply_retrieval_state(selected.prepared_state);
    const offset = selected.prepared_turn_capacity - selected.previous_turn_capacity;
    if (offset < 0) throw new Error("committed memory cycle cannot shrink capacity");
    if (offset) this.events = this.events.map(event => ({ ...event, hub_node_id: event.hub_node_id === null ? null : event.hub_node_id + offset }));
    validateFeedback(causal.feedback, this.state_version);
    for (const node of causal.feedback.forget_nodes) this.inhibited_nodes.add(node);
    for (const node of causal.feedback.remember_nodes) this.inhibited_nodes.delete(node);
    this.graph.apply_feedback_inhibition(this.inhibited_nodes);
    const evidence = learningEvidence(selected.evidence), diffusion = selected.diffusion;
    const event = { ...this.graph.learn(this.state_version, evidence, diffusion), pushes: diffusion.pushes, residual_l1: diffusion.residual_l1 };
    this.graph.reinforce_feedback_nodes(causal.feedback.remember_nodes, causal.feedback.remember_boost);
    let pool = this.feature_pool;
    if (pool) {
      if (pool.turns.length === this.state_version) pool.append_turn(causal);
      else if (pool.turns[this.state_version]!.turn_id !== causal.turn_id) throw new Error("feature pool committed turn differs from causal turn");
    }
    this.turns.push(causal);
    for (const members of this.burst_members.values()) {
      const retained = members.filter(node => !this.inhibited_nodes.has(node)); members.splice(0, members.length, ...retained);
    }
    let members = this.burst_members.get(causal.session_key);
    if (!members) this.burst_members.set(causal.session_key, members = []);
    if (selected.burst_decision.continued) members.push(causal.node_id); else members.splice(0, members.length, causal.node_id);
    if (!pool) this.feature_pool = pool = new BurstAwareFeaturePool(this.turns, { appendable: true });
    this.context = pool.build_context(members.filter(node => !this.inhibited_nodes.has(node)).map(node => [node, 1]));
    this.events.push(event); this.evidence.push(evidence);
    if (selected.completion_evaluated) this.recalls.push({ query_node_id: causal.node_id, completion: selected.completion });
    return { event, evidence, diffusion, retrieval_recomputed: recomputed };
  }

  private retrieval_pool(turn: Turn): BurstAwareFeaturePool {
    if (!this.feature_pool) return new BurstAwareFeaturePool([...this.turns, turn]);
    if (this.feature_pool.turns.length === this.state_version) return this.feature_pool.query_view(turn);
    if (this.feature_pool.turns[this.state_version]!.turn_id !== turn.turn_id) throw new Error("feature pool turn differs from causal query");
    return this.feature_pool;
  }
  private burst_decision(pool: BurstAwareFeaturePool, turn: Turn, capture: boolean): BurstDecision {
    if (this.state_version === 0) return { evidence: { seed: [], channels: {}, time_prior: 0.5, continuation: 0.5, surprise: 1 },
      fields: Object.fromEntries(["query_dense", "query_bm25", "context_dense", "context_bm25"].map(name => [name, new Float64Array()])),
      base_continuation: 0.5, context_dependence: 0.5, context_mass: 0, continued: false, visible_nodes: [],
      context: { members: [], dense: null, terms: [] } };
    const visible = (this.burst_members.get(turn.session_key) ?? []).filter(node => !this.inhibited_nodes.has(node));
    const context = visible.length ? pool.build_context(visible.map(node => [node, 1])) : { members: [], dense: null, terms: [] };
    return pool.infer_burst_seed(this.state_version, context, visible, capture);
  }

  serialize(): CycleSnapshot {
    return { config: { restart: this.config.restart, tolerance: this.config.tolerance, learning_rate: this.config.learning_rate,
      activation_power: this.config.activation_power, recurrent_budget: this.config.recurrent_budget,
      reverse_temporal_ratio: this.config.reverse_temporal_ratio, forgetting_enabled: this.config.forgetting_enabled },
      turns: plain(this.turns) as CycleSnapshot["turns"], graph: this.graph.serialize(), context: plain(this.context),
      events: clone(this.events), evidence: this.evidence.map(item => plain(item) as TicketSnapshot), recalls: clone(this.recalls),
      burst_members: Object.fromEntries([...this.burst_members].map(([session, nodes]) => [session, [...nodes]])), inhibited_nodes: [...this.inhibited_nodes].sort((a, b) => a - b) };
  }
  static restore(snapshot: CycleSnapshot): MemoryCycle {
    const count = snapshot.turns.length;
    if (snapshot.graph.turn_count < count || snapshot.events.length !== count || snapshot.evidence.length !== count || snapshot.graph.state.current_event !== count - 1)
      throw new Error("restored memory graph history differs from turns");
    const config = new MemoryConfig(snapshot.config), cycle = new MemoryCycle(config, { turn_capacity: snapshot.graph.turn_count });
    cycle.turns = snapshot.turns.map(value => {
      const turn = clone(value) as unknown as Turn;
      return { ...turn, user_dense: turn.user_dense === null ? null : Float32Array.from(turn.user_dense),
        assistant_dense: turn.assistant_dense === null ? null : Float32Array.from(turn.assistant_dense) };
    });
    cycle.graph = DynamicMemoryGraph.restore(snapshot.graph, config);
    cycle.context = snapshot.context === null ? null : restoreContext(snapshot.context as unknown as ContextState);
    cycle.events = clone(snapshot.events); cycle.evidence = snapshot.evidence.map(value => restoreEvidence(value as unknown as SeedEvidence));
    cycle.recalls = clone(snapshot.recalls); cycle.burst_members = new Map(Object.entries(snapshot.burst_members).map(([session, nodes]) => [session, [...nodes]]));
    for (let index = 0; index < cycle.turns.length; index++) {
      const feedback = cycle.turns[index]!.feedback; validateFeedback(feedback, index);
      for (const node of feedback.forget_nodes) cycle.inhibited_nodes.add(node);
      for (const node of feedback.remember_nodes) cycle.inhibited_nodes.delete(node);
    }
    return cycle;
  }
}
