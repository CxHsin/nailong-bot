// Ported from akashic-agent 94027a5c, MIT, Copyright (c) 2026 kachofugetsu09.
// Full license notice is in ./LICENSE.
export type Vector = Float32Array | Float64Array | readonly number[];
export type Terms = ReadonlyArray<readonly [string, number]>;
export type WeightedNodes = ReadonlyArray<readonly [number, number]>;

export class EmbeddingSpaceMismatchError extends Error {}
export class MemoryRebuildRequiredError extends Error {}

export class MemoryConfig {
  restart = 0.25;
  tolerance = 1e-7;
  learning_rate = 0.5;
  activation_power = 2;
  recurrent_budget = 1;
  reverse_temporal_ratio = 0.25;
  forgetting_enabled = true;
  constructor(options: Partial<MemoryConfig> = {}) { Object.assign(this, options); this.validate(); }
  validate(): void {
    for (const name of ["tolerance", "learning_rate", "activation_power", "recurrent_budget"] as const)
      if (!(this[name] > 0)) throw new Error(`${name} must be positive`);
    if (!(this.restart > 0 && this.restart <= 1)) throw new Error("restart must be in (0, 1]");
    if (this.learning_rate > 1) throw new Error("learning_rate must be in (0, 1]");
    if (this.activation_power < 1) throw new Error("activation_power must be at least 1");
    if (!(this.reverse_temporal_ratio > 0 && this.reverse_temporal_ratio < 1))
      throw new Error("reverse_temporal_ratio must be in (0, 1)");
  }
}

export interface TurnFeedback {
  remember_nodes: readonly number[];
  forget_nodes: readonly number[];
  remember_boost: number;
}
export const emptyFeedback = (): TurnFeedback => ({ remember_nodes: [], forget_nodes: [], remember_boost: 1 });

export interface Turn {
  node_id: number; turn_id: string; session_key: string; user_seq: number;
  user_message_id: string; assistant_message_id: string; started_at: string; committed_at: string;
  user_text: string; assistant_text: string; user_dense: Vector | null; assistant_dense: Vector | null;
  user_terms: Terms; assistant_terms: Terms; inter_gap_seconds: number | null; feedback: TurnFeedback;
}
export interface ContextState { members: WeightedNodes; dense: Vector | null; terms: Terms }
export interface SeedEvidence {
  seed: WeightedNodes; channels: Record<string, ReadonlySet<number>>;
  time_prior: number; continuation: number; surprise: number;
}
export interface DiffusionResult {
  reserve: Float64Array; active_nodes: Int32Array; pushes: number; residual_l1: number;
  parent_node: Int32Array | null; parent_edge: Int32Array | null;
}
export interface PlasticityResult {
  hub_node_id: number | null; threshold: number; integrated: WeightedNodes;
  inhibited_mass: number; potentiated_mass: number; observed_mass: number;
  recurrent_mass: number; reactivated_mass: number; pushes: number; residual_l1: number;
}
export interface Capture { query_node_id: number; evidence: SeedEvidence; diffusion: DiffusionResult }
