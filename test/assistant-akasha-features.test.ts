import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tokenize } from "../src/assistant/akasha/lexical.js";
import { FeaturePool, BurstAwareFeaturePool } from "../src/assistant/akasha/features.js";
import type { Turn } from "../src/assistant/akasha/model.js";
import { SourceFeaturePool } from "../src/assistant/akasha/sources.js";
import { sparsemax, tail_surprisal } from "../src/assistant/akasha/numeric.js";

const reference = JSON.parse(readFileSync(new URL("./fixtures/akasha/upstream-golden.json", import.meta.url), "utf8"));

test("Akasha search tokenization preserves original Python words, frequencies and UTF-8 order", () => {
  for (const sample of reference.tokenization) assert.deepEqual(tokenize(sample.text), sample.terms, sample.text);
});

function turn(value: any): Turn {
  return { ...value, user_dense: value.user_dense === null ? null : new Float32Array(value.user_dense),
    assistant_dense: value.assistant_dense === null ? null : new Float32Array(value.assistant_dense) };
}

function close(actual: ArrayLike<number>, expected: number[], tolerance = 2e-6) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(actual[index]! - expected[index]!) <= tolerance,
      `${index}: ${actual[index]} differs from original Python ${expected[index]}`);
  }
}

test("Akasha causal features match original Python across float32 and mixed context boundaries", () => {
  const sample = reference.feature_boundaries;
  const pool = new FeaturePool(sample.inputs.map(turn));
  close(pool.dense_scores(new Float32Array(sample.cue), sample.inputs.length), sample.float32_scores);
  close(pool.dense_scores(new Float64Array(sample.cue), sample.inputs.length), sample.float64_scores, 1e-10);
  const context = pool.build_context([[0, 1], [1, 1], [2, 1]]);
  close(context.dense!, sample.context.dense);
  assert.deepEqual(context.members, sample.context.members);
  assert.deepEqual(context.terms, sample.context.terms);
  close(pool.dense_scores(context.dense, sample.inputs.length), sample.context_scores);
  close(pool.bm25_scores(new Map([["alpha", 0.5], ["beta", 0.5]]), sample.inputs.length), sample.bm25, 1e-10);
});

test("valid original sources without closed dialogue remain searchable without graph learning", () => {
  const sample = reference.source_only;
  const pool = new SourceFeaturePool(sample.documents);
  for (const query of sample.queries) {
    const actual = pool.query(query.text, query.dense, 10);
    assert.deepEqual(actual.map(item => item.id), query.results.map((item: any) => item.id));
    close(actual.map(item => item.score), query.results.map((item: any) => item.score), 1e-10);
  }
  assert.deepEqual(pool.query("明天游玩安排", [1, 0, 0], 0), []);
  assert.deepEqual(new SourceFeaturePool([]).query("原文", [1, 0, 0], 10), []);
});

test("one valid raw source remains searchable only with positive direct evidence", () => {
  const pool = new SourceFeaturePool([{ id: "only", text: "weekend travel", dense: [1, 0, 0] }]);
  assert.deepEqual(pool.query("湖边游览", [1, 0, 0], 10), [{ id: "only", score: 1 }]);
  assert.deepEqual(pool.query("unrelated", [0, 1, 0], 10), []);
  assert.deepEqual(pool.query("unrelated", [-1, 0, 0], 10), []);
  assert.deepEqual(pool.query("unrelated", null, 10), []);
  assert.equal(pool.query("travel", null, 10)[0]?.id, "only");
});

test("raw source calibration never admits orthogonal or negative records without lexical evidence", () => {
  const pool = new SourceFeaturePool([{ id: "orthogonal", text: "白茶", dense: [1, 0] },
    { id: "positive", text: "收到", dense: [0, 1] }, { id: "negative", text: "红茶", dense: [0, -1] }]);
  assert.deepEqual(pool.query("当前工作", [0, 1], 10).map(item => item.id), ["positive"]);
});

test("Akasha sparse evidence retains original Python threshold support and tied-node order", () => {
  for (const sample of reference.numeric_boundaries.sparsemax) {
    const actual = sparsemax(sample.input);
    assert.deepEqual(actual.map(([node]) => node), sample.output.map(([node]: number[]) => node));
    close(actual.map(([, value]) => value), sample.output.map(([, value]: number[]) => value), 1e-10);
  }
  for (const sample of reference.numeric_boundaries.tail_surprisal)
    close(tail_surprisal(sample.input), sample.output, 1e-10);
});

test("appendable Akasha burst evidence matches original causal sequence and session context", () => {
  for (const scenario of reference.cases) {
    const pool = new BurstAwareFeaturePool([turn(scenario.steps[0].input)], { appendable: true });
    for (let index = 1; index < scenario.steps.length; index++) {
      const step = scenario.steps[index], completed = turn(step.input);
      const cue = { ...completed, assistant_text: "", assistant_dense: null, assistant_terms: [] };
      const prior = scenario.steps[index - 1].state;
      const visible = (prior.burst_members[completed.session_key] ?? []).filter((node: number) => !prior.inhibited_nodes.includes(node));
      const context = visible.length ? pool.build_context(visible.map((node: number) => [node, 1] as const))
        : { members: [], dense: null, terms: [] };
      const view = pool.query_view(cue);
      const actual = view.infer_burst_seed(index, context, visible, true), expected = step.ticket.burst_decision;
      assert.equal(actual.continued, expected.continued, `${scenario.name} step ${index}`);
      assert.deepEqual(actual.visible_nodes, expected.visible_nodes);
      assert.deepEqual(actual.evidence.seed.map(([node]) => node), expected.evidence.seed.map(([node]: number[]) => node));
      close(actual.evidence.seed.map(([, value]) => value), expected.evidence.seed.map(([, value]: number[]) => value));
      for (const name of Object.keys(expected.fields)) close(actual.fields[name]!, expected.fields[name]);
      close([actual.base_continuation, actual.context_dependence, actual.context_mass,
        actual.evidence.time_prior, actual.evidence.continuation, actual.evidence.surprise],
      [expected.base_continuation, expected.context_dependence, expected.context_mass,
        expected.evidence.time_prior, expected.evidence.continuation, expected.evidence.surprise]);
      for (const [name, members] of Object.entries(actual.evidence.channels))
        assert.deepEqual([...members].sort((a, b) => a - b), expected.evidence.channels[name]);
      pool.append_turn(completed);
    }
  }
});
