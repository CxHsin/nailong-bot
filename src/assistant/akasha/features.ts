// Ported from akashic-agent 94027a5c, MIT, Copyright (c) 2026 kachofugetsu09.
// Full license notice is in ./LICENSE.
import type { ContextState, SeedEvidence, Terms, Turn, Vector, WeightedNodes } from "./model.js";
import { utf8Compare } from "./lexical.js";
import { dot, fsum, normalize_pairs_by_id, sigmoid, sparsemax, tail_surprisal, unit } from "./numeric.js";
export { sparsemax as _sparsemax, tail_surprisal as _tail_surprisal, unit as _unit,
  effective_support, binary_entropy } from "./numeric.js";

function normalized(values: Terms | ReadonlyMap<string, number>): Map<string, number> {
  const pairs = [...values];
  const total = fsum(pairs.map(([, value]) => value));
  return total === 0 ? new Map() : new Map(pairs.map(([key, value]) => [key, value / total]));
}

function combined_terms(turn: Pick<Turn, "user_terms" | "assistant_terms">): Array<[string, number]> {
  const values = new Map<string, number>();
  for (const [term, count] of [...turn.user_terms, ...turn.assistant_terms]) values.set(term, (values.get(term) ?? 0) + count);
  return [...values].sort(([first], [second]) => utf8Compare(first, second));
}

function term_total(turn: Pick<Turn, "user_terms" | "assistant_terms">): number {
  return [...turn.user_terms, ...turn.assistant_terms].reduce((sum, [, value]) => sum + value, 0);
}

function term_support(terms: Terms): number {
  const values = normalized(terms);
  return values.size ? Math.exp(-fsum([...values.values()].map(value => value * Math.log(value)))) : 0;
}

function lower_bound(values: ArrayLike<number>, target: number): number {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle]! < target) low = middle + 1; else high = middle; }
  return low;
}

function log_evidence(observed: number, background: ArrayLike<number>): number {
  const count = Array.from(background).filter(value => value >= observed).length;
  return Math.log((1 - Math.log((count + 1) / (background.length + 1))) / 2);
}

function combine_odds(first: number, second: number): number {
  first = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, first));
  second = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, second));
  return sigmoid(Math.log(first / (1 - first)) + Math.log(second / (1 - second)));
}

function mix_sources(fields: Record<string, Float64Array>, contextMass: number): Array<[number, number]> {
  const direct = sparsemax(Float64Array.from(fields.query_dense!, (value, index) => value + fields.query_bm25![index]!));
  const context = sparsemax(Float64Array.from(fields.context_dense!, (value, index) => value + fields.context_bm25![index]!));
  if (!direct.length) return context;
  if (!context.length) return direct;
  const mixed = new Map<number, number>();
  for (const [node, value] of direct) mixed.set(node, (mixed.get(node) ?? 0) + (1 - contextMass) * value);
  for (const [node, value] of context) mixed.set(node, (mixed.get(node) ?? 0) + contextMass * value);
  return normalize_pairs_by_id([...mixed]);
}

export interface FeatureDocument {
  user_dense: Vector | null; assistant_dense: Vector | null; user_terms: Terms; assistant_terms: Terms;
  inter_gap_seconds: number | null;
}

/** Causal row features shared by complete Turn graphs and source-only documents. */
export class FeaturePool<T extends FeatureDocument = Turn> {
  turns: T[];
  user_dense: Float32Array[] = [];
  assistant_dense: Float32Array[] = [];
  user_mask: boolean[] = [];
  assistant_mask: boolean[] = [];
  lengths: number[] = [];
  prefix_lengths: number[] = [0];
  gaps: number[] = [];
  term_order = new Map<string, number>();
  postings = new Map<string, { positions: number[]; frequencies: number[] }>();
  protected _query_turn: T | null = null;
  protected _appendable: boolean;
  protected _size: number;
  protected dimension: number;

  constructor(turns: readonly T[], options: { appendable?: boolean } = {}) {
    if (!turns.length) throw new Error("memory rebuild requires at least one turn");
    this.turns = [...turns]; this._appendable = options.appendable ?? false; this._size = turns.length;
    this.dimension = turns.flatMap(turn => [turn.user_dense, turn.assistant_dense]).find(vector => vector !== null)?.length ?? 0;
    for (const turn of turns) this.write_row(turn);
  }

  protected write_row(turn: T): void {
    const node = this.user_dense.length;
    for (const [vector, matrix, mask] of [
      [turn.user_dense, this.user_dense, this.user_mask], [turn.assistant_dense, this.assistant_dense, this.assistant_mask],
    ] as const) {
      if (vector !== null && vector.length !== this.dimension) throw new Error("dense vectors must share one dimension");
      matrix.push(vector === null ? new Float32Array(this.dimension) : Float32Array.from(vector));
      mask.push(vector !== null);
    }
    const length = term_total(turn);
    this.lengths.push(length); this.prefix_lengths.push(this.prefix_lengths.at(-1)! + length);
    this.gaps.push(turn.inter_gap_seconds ?? Number.NaN);
    for (const [term, tf] of combined_terms(turn)) {
      if (!this.term_order.has(term)) this.term_order.set(term, this.term_order.size);
      let posting = this.postings.get(term);
      if (!posting) this.postings.set(term, posting = { positions: [], frequencies: [] });
      posting.positions.push(node); posting.frequencies.push(tf);
    }
  }

  dense_scores(cue: Vector | null, end: number): Float64Array {
    if (cue === null || end === 0) return new Float64Array(end);
    const float32 = !(cue instanceof Float64Array);
    return Float64Array.from({ length: end }, (_, node) => {
      const user = this.user_mask[node] ? dot(this.user_dense[node]!, cue, float32) : -1;
      const assistant = this.assistant_mask[node] ? dot(this.assistant_dense[node]!, cue, float32) : -1;
      return this.user_mask[node] || this.assistant_mask[node] ? Math.max(user, assistant) : 0;
    });
  }

  bm25_scores(query: ReadonlyMap<string, number> | Record<string, number>, end: number): Float64Array {
    const terms = query instanceof Map ? query : new Map(Object.entries(query));
    const scores = new Float64Array(end);
    if (!terms.size || end === 0) return scores;
    const average = this.prefix_lengths[end]! / end;
    const ordered = [...terms.keys()].sort((first, second) => (this.term_order.get(first) ?? Infinity) - (this.term_order.get(second) ?? Infinity));
    for (const term of ordered) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const stop = lower_bound(posting.positions, end);
      if (!stop) continue;
      const idf = Math.log1p((end - stop + 0.5) / (stop + 0.5));
      for (let index = 0; index < stop; index++) {
        const node = posting.positions[index]!, tf = posting.frequencies[index]!;
        const saturation = tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * this.lengths[node]! / average));
        scores[node] = scores[node]! + terms.get(term)! * idf * saturation;
      }
    }
    return scores;
  }

  bm25_document_score(query: ReadonlyMap<string, number>, document: ReadonlyMap<string, number>, end: number): number {
    const average = this.prefix_lengths[end]! / end;
    const length = fsum(document.values());
    const common = [...query.keys()].filter(term => document.has(term)).sort((first, second) =>
      (this.term_order.get(first) ?? Infinity) - (this.term_order.get(second) ?? Infinity));
    const parts: number[] = [];
    for (const term of common) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = lower_bound(posting.positions, end);
      if (!df) continue;
      const tf = document.get(term)!;
      parts.push(query.get(term)! * Math.log1p((end - df + 0.5) / (df + 0.5)) * tf * 2.2 /
        (tf + 1.2 * (0.25 + 0.75 * length / average)));
    }
    return fsum(parts);
  }

  time_prior(gap: number | null, end: number): number {
    if (gap === null || end <= 1) return 0.5;
    const observed = this.gaps.slice(1, end).filter(Number.isFinite);
    return (observed.filter(value => value >= gap).length + 0.5) / (observed.length + 1);
  }

  query_surprise(query: T, end: number, denseScores: ArrayLike<number>, bm25Scores: ArrayLike<number>): number {
    const residuals: number[] = [];
    if (query.user_dense !== null && this.user_mask.slice(0, end).some(Boolean))
      residuals.push(1 - Math.min(1, Math.max(0, Math.max(...Array.from(denseScores)))));
    const terms = normalized(query.user_terms);
    if (terms.size) {
      const selfScore = this.bm25_document_score(terms, terms, end);
      if (selfScore > 0) residuals.push(1 - Math.min(1, Math.max(0, Math.max(...Array.from(bm25Scores)) / selfScore)));
    }
    return residuals.length ? Math.sqrt(fsum(residuals.map(value => value * value)) / residuals.length) : 1;
  }

  continuation_belief(query: T, context: ContextState, end: number, timePrior: number,
    denseScores: ArrayLike<number>, bm25Scores: ArrayLike<number>): number {
    let logEvidence = 0;
    if (query.user_dense !== null && context.dense !== null)
      logEvidence += log_evidence(dot(query.user_dense, context.dense), denseScores);
    const queryTerms = normalized(query.user_terms), contextTerms = new Map(context.terms);
    if (queryTerms.size && contextTerms.size)
      logEvidence += log_evidence(this.bm25_document_score(queryTerms, contextTerms, end), bm25Scores);
    return sigmoid(Math.log(timePrior / (1 - timePrior)) + logEvidence);
  }

  build_context(members: WeightedNodes): ContextState {
    const weights = normalize_pairs_by_id(members);
    const dense = new Float64Array(this.dimension);
    let hasDense = false;
    const lexical = new Map<string, number>();
    for (const [node, weight] of weights) {
      const turn = this.turns[node]!;
      const vectors = [turn.user_dense, turn.assistant_dense].filter((value): value is Vector => value !== null);
      if (vectors.length) {
        const combined = new Float32Array(this.dimension);
        for (const vector of vectors) for (let index = 0; index < this.dimension; index++) combined[index] = combined[index]! + vector[index]!;
        const row = unit(combined, true);
        for (let index = 0; index < this.dimension; index++) dense[index] = dense[index]! + weight * row[index]!;
        hasDense = true;
      }
      for (const [term, value] of normalized(combined_terms(turn))) lexical.set(term, (lexical.get(term) ?? 0) + weight * value);
    }
    return { members: weights, dense: hasDense ? unit(dense, false) : null,
      terms: [...lexical].sort(([first], [second]) => utf8Compare(first, second)) };
  }
}

export interface BurstDecision {
  evidence: SeedEvidence; fields: Record<string, Float64Array>; base_continuation: number;
  context_dependence: number; context_mass: number; continued: boolean;
  visible_nodes: readonly number[]; context: ContextState;
}

export class BurstAwareFeaturePool extends FeaturePool<Turn> {
  context_dependence: number[] = [];
  private _ordered_supports: number[] = [];
  private _query_context_dependence = 0.5;
  constructor(turns: readonly Turn[], options: { appendable?: boolean } = {}) {
    super(turns, options);
    for (const turn of turns) {
      const support = term_support(turn.user_terms);
      this.context_dependence.push(this.next_dependence(turn));
      this._ordered_supports.splice(lower_bound(this._ordered_supports, support), 0, support);
    }
  }

  query_view(turn: Turn): BurstAwareFeaturePool {
    const view = Object.assign(Object.create(BurstAwareFeaturePool.prototype) as BurstAwareFeaturePool, this);
    view._query_turn = turn; view._appendable = false; view._query_context_dependence = this.next_dependence(turn);
    return view;
  }

  append_turn(turn: Turn): void {
    if (!this._appendable) throw new Error("feature pool is not appendable");
    if (turn.node_id !== this._size) throw new Error("feature pool turn must append at its node ID");
    const vectors = [turn.user_dense, turn.assistant_dense].filter((value): value is Vector => value !== null);
    if (this.dimension === 0 && vectors.length) {
      this.dimension = vectors[0]!.length;
      this.user_dense = this.user_dense.map(() => new Float32Array(this.dimension));
      this.assistant_dense = this.assistant_dense.map(() => new Float32Array(this.dimension));
    }
    this.write_row(turn);
    const support = term_support(turn.user_terms);
    this.context_dependence.push(this.next_dependence(turn));
    this._ordered_supports.splice(lower_bound(this._ordered_supports, support), 0, support);
    this.turns.push(turn); this._size++;
  }

  private next_dependence(turn: Turn): number {
    const support = term_support(turn.user_terms);
    if (!this._ordered_supports.length || support <= 0) return 0.5;
    return (this._ordered_supports.length - lower_bound(this._ordered_supports, support) + 0.5) / (this._ordered_supports.length + 1);
  }

  infer_burst_seed(index: number, candidateContext: ContextState, visibleNodes: readonly number[], captureChannels: boolean): BurstDecision {
    const query = this.turns[index] ?? (index === this.turns.length ? this._query_turn : null);
    if (!query) throw new Error(`query turn missing at ${index}`);
    const terms = normalized(query.user_terms);
    const queryDense = this.dense_scores(query.user_dense, index), queryBm25 = this.bm25_scores(terms, index);
    const contextDense = this.dense_scores(candidateContext.dense, index), contextBm25 = this.bm25_scores(new Map(candidateContext.terms), index);
    const fields = { query_dense: tail_surprisal(queryDense), query_bm25: tail_surprisal(queryBm25),
      context_dense: tail_surprisal(contextDense), context_bm25: tail_surprisal(contextBm25) };
    const timePrior = this.time_prior(query.inter_gap_seconds, index);
    const base = this.continuation_belief(query, candidateContext, index, timePrior, queryDense, queryBm25);
    const dependence = index < this._size ? this.context_dependence[index]! : this._query_context_dependence;
    const continuation = base + (1 - base) * timePrior * dependence;
    const continued = visibleNodes.length > 0 && continuation >= 0.5;
    const contextMass = continued ? combine_odds(continuation, dependence) : 0;
    const seed = mix_sources(fields, contextMass);
    const nodes = captureChannels ? undefined : seed.map(([node]) => node);
    const channels: Record<string, Set<number>> = {};
    for (const [name, values] of Object.entries(fields)) channels[name] = new Set(
      (nodes ?? [...values.keys()]).filter(node => values[node]! > 0));
    return { evidence: { seed, channels, time_prior: timePrior, continuation,
      surprise: this.query_surprise(query, index, queryDense, queryBm25) }, fields, base_continuation: base,
      context_dependence: dependence, context_mass: contextMass, continued,
      visible_nodes: continued ? visibleNodes : [], context: continued ? candidateContext : { members: [], dense: null, terms: [] } };
  }
}
