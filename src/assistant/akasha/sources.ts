// Host adaptation using Akasha's original feature mathematics. It does not create
// completed Turns or perform learning. Upstream license is preserved in ./LICENSE.
import { FeaturePool, type FeatureDocument } from "./features.js";
import { tokenize } from "./lexical.js";
import type { Vector } from "./model.js";
import { fsum, sparsemax, tail_surprisal } from "./numeric.js";

export interface SourceDocument { id: string; text: string; dense: Vector | null }

/** Direct evidence from valid raw records, including records lacking Turn closure. */
export class SourceFeaturePool {
  private readonly documents: readonly SourceDocument[];
  private readonly pool: FeaturePool<FeatureDocument> | null;
  constructor(documents: readonly SourceDocument[]) {
    this.documents = [...documents];
    this.pool = documents.length ? new FeaturePool(documents.map(document => ({
      user_dense: document.dense, assistant_dense: null, user_terms: tokenize(document.text),
      assistant_terms: [], inter_gap_seconds: null,
    }))) : null;
  }

  query(text: string, dense: Vector | null, limit = 10): Array<{ id: string; score: number }> {
    if (!this.pool || limit <= 0) return [];
    const terms = tokenize(text), total = fsum(terms.map(([, count]) => count));
    const queryTerms = new Map(terms.map(([term, count]) => [term, count / total]));
    const denseScores = this.pool.dense_scores(dense === null ? null : Float32Array.from(dense), this.documents.length);
    const bm25Scores = this.pool.bm25_scores(queryTerms, this.documents.length);
    // A host source namespace may contain just one unclosed record. Empirical
    // tail calibration then has no contrast; preserve positive direct support
    // without changing the original Turn graph's evidence or learning rules.
    if (this.documents.length === 1) {
      const score = Math.max(0, denseScores[0]!, bm25Scores[0]!);
      return score > 0 ? [{ id: this.documents[0]!.id, score }] : [];
    }
    const denseEvidence = tail_surprisal(denseScores), lexicalEvidence = tail_surprisal(bm25Scores);
    const evidence = Float64Array.from(denseEvidence, (value, index) => value + lexicalEvidence[index]!);
    return sparsemax(evidence).filter(([node]) => denseScores[node]! > 0 || bm25Scores[node]! > 0)
      .sort(([first, firstScore], [second, secondScore]) => secondScore - firstScore || first - second)
      .slice(0, Math.floor(limit)).map(([node, score]) => ({ id: this.documents[node]!.id, score }));
  }
}
