import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MemoryCycle, restoreTicket, serializeTicket, type CycleSnapshot } from "../src/assistant/akasha/cycle.js";
import type { Turn } from "../src/assistant/akasha/model.js";
import { MemoryConfig } from "../src/assistant/akasha/model.js";
import { erfc } from "../src/assistant/akasha/numeric.js";
import { read_pattern_completion } from "../src/assistant/akasha/readout.js";
import { DynamicMemoryGraph } from "../src/assistant/akasha/graph.js";
import { BurstAwareFeaturePool } from "../src/assistant/akasha/features.js";

const reference = JSON.parse(readFileSync(new URL("./fixtures/akasha/upstream-golden.json", import.meta.url), "utf8"));
function turn(value: any): Turn {
  return { ...value, user_dense: value.user_dense === null ? null : new Float32Array(value.user_dense),
    assistant_dense: value.assistant_dense === null ? null : new Float32Array(value.assistant_dense) };
}
function plain(value: any): any {
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (value instanceof Set) return [...value].sort((a, b) => a - b);
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]));
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}
function compare(actual: any, expected: any, path = "root"): void {
  actual = plain(actual);
  if (typeof expected === "number") {
    if (Number.isInteger(expected) && /(?:node|edge|kind|pushes|count|capacity|version|members\[\d+\]\[0\]|seed\[\d+\]\[0\])/.test(path))
      assert.equal(actual, expected, path);
    else assert.ok(Math.abs(actual - expected) <= 2e-6 + Math.abs(expected) * 1e-8, `${path}: ${actual} != Python ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path); assert.equal(actual.length, expected.length, `${path}.length`);
    for (let index = 0; index < expected.length; index++) compare(actual[index], expected[index], `${path}[${index}]`);
  } else if (expected && typeof expected === "object") {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}.keys`);
    for (const key of Object.keys(expected)) compare(actual[key], expected[key], `${path}.${key}`);
  } else assert.equal(actual, expected, path);
}

test("Akasha full causal cycle matches original Python tickets, plasticity and graph state", () => {
  for (const scenario of reference.cases) {
    const cycle = new MemoryCycle();
    for (const step of scenario.steps) {
      const completed = turn(step.input);
      const cue = { ...completed, assistant_text: "", assistant_dense: null, assistant_terms: [] };
      const before = cycle.serialize();
      const ticket = cycle.retrieve(cue, { capture_paths: true });
      assert.deepEqual(cycle.serialize(), before, "retrieval cannot mutate committed state");
      compare(ticket, step.ticket, `${scenario.name}.ticket${completed.node_id}`);
      compare(cycle.commit(completed, ticket), step.commit, `${scenario.name}.commit${completed.node_id}`);
      compare(cycle.serialize(), step.state, `${scenario.name}.state${completed.node_id}`);
    }
    for (const sample of scenario.queries) {
      const ticket = cycle.retrieve(turn(sample.input), { capture_paths: true });
      assert.deepEqual(ticket.completion.items.map(item => item.node_id), sample.ticket.completion.items.map((item: any) => item.node_id));
      compare(ticket, sample.ticket, `${scenario.name}.probe`);
      const restored = MemoryCycle.restore(JSON.parse(JSON.stringify(cycle.serialize())));
      compare(restored.serialize(), scenario.state, `${scenario.name}.restored`);
      compare(restored.retrieve(turn(sample.input), { capture_paths: true }), sample.restored_ticket, `${scenario.name}.restoredProbe`);
    }
  }
});

test("Akasha V8 contextual and independent readout retain Python ranking, sources and inhibition", () => {
  for (const sample of reference.readout) {
    const ticket = restoreTicket({ ...sample.options,
      burst_decision: { evidence: sample.options.evidence, context: sample.options.context, fields: sample.options.precomputed_fields },
      completion: sample.output, prepared_state: sample.graph.state });
    const graph = DynamicMemoryGraph.restore(sample.graph), before = graph.serialize();
    const options = { ...sample.options, graph, pool: new BurstAwareFeaturePool(sample.turns.map(turn)), query: turn(sample.options.query),
      context: ticket.burst_decision.context, precomputed_fields: ticket.burst_decision.fields,
      evidence: ticket.evidence, diffusion: ticket.diffusion,
      historical_surprise: Float64Array.from(sample.options.historical_surprise),
      config: new MemoryConfig(sample.options.config), inhibited_nodes: new Set<number>(sample.options.inhibited_nodes) };
    const actual = read_pattern_completion(options);
    assert.deepEqual(actual.items.map(item => [item.node_id, item.sources, item.basin_ids]),
      sample.output.items.map((item: any) => [item.node_id, item.sources, item.basin_ids]), sample.name);
    compare(actual, sample.output, sample.name);
    compare(read_pattern_completion({ ...options, precomputed_fields: undefined }), sample.without_precomputed, `${sample.name}.withoutFields`);
    assert.deepEqual(graph.serialize(), before, "readout must not mutate graph");
  }
});

test("Akasha recurrence survival uses accurate original Python complementary error values", () => {
  for (const sample of reference.numeric_boundaries.erfc) {
    const actual = erfc(sample.input);
    assert.ok(Math.abs(actual - sample.output) <= 2e-15 + Math.abs(sample.output) * 1e-13,
      `${sample.input}: ${actual} != math.erfc ${sample.output}`);
  }
});

test("serialized query tickets survive reopen and stale versions recompute exactly once in causal order", () => {
  const sample = reference.stale_ticket;
  const cycle = MemoryCycle.restore(sample.before_commit as CycleSnapshot);
  const ticket = restoreTicket(JSON.parse(JSON.stringify(sample.ticket)));
  assert.deepEqual(serializeTicket(ticket), JSON.parse(JSON.stringify(sample.ticket)));
  compare(cycle.commit(turn(sample.waiting), ticket), sample.commit, "stale.commit");
  compare(cycle.serialize(), sample.after_commit, "stale.state");
  const empty = new MemoryCycle();
  const first = turn(reference.cases[0].steps[0].input);
  const fresh = empty.retrieve({ ...first, assistant_text: "", assistant_dense: null, assistant_terms: [] }, { capture_paths: true });
  const restored = MemoryCycle.restore(JSON.parse(JSON.stringify(empty.serialize())));
  const result = restored.commit(first, restoreTicket(JSON.parse(JSON.stringify(serializeTicket(fresh)))));
  assert.equal(result.retrieval_recomputed, false);
  compare(restored.serialize(), reference.cases[0].steps[0].state, "restoredFresh.state");
});
