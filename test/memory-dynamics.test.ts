import assert from "node:assert/strict";
import test from "node:test";
import { boundedAdd, DEFAULT_DYNAMICS, learningSignal, memoryDynamics, settleNode } from "../src/memory/dynamics.js";
import { graphAt, memoryGraph } from "../src/memory/graph.js";
import type { StoredEvent } from "../src/runtime/runtime-types.js";
import { rankMemories, recallConfig } from "../src/memory/recall.js";

test("memory time constants are exponential decay/recovery constants, not half lives", () => {
  const initial = { strength: 3, resource: 0, at: 0 };
  const week = settleNode(initial, 7 * 86400_000);
  assert.ok(Math.abs(week.strength - 1.103638323514327) < 1e-12);
  const halfHour = settleNode(initial, 30 * 60_000);
  assert.ok(Math.abs(halfHour.resource - 0.6321205588285577) < 1e-12);
  const graph = { states: new Map(), edges: new Map([["edge", { from: "a", to: "b", weight: 2, at: 0 }]]), originals: [], initializations: [] };
  assert.ok(Math.abs(graphAt(graph, 14 * 86400_000).edges[0]!.weight - 0.7357588823428847) < 1e-12);
});

test("learning is bounded and monotone; invalid numbers and backward clocks are safe", () => {
  assert.ok(learningSignal(100) > learningSignal(1));
  assert.ok(learningSignal(100) < 1);
  assert.equal(learningSignal(NaN), 0); assert.equal(learningSignal(Infinity), 0);
  assert.equal(boundedAdd(2.9, 100, 3), 3);
  assert.ok(boundedAdd(2, 0.18, 3) > 2);
  assert.throws(() => boundedAdd(NaN, 1, 3));
  assert.throws(() => memoryDynamics({ edgeMs: 0 }));
  assert.throws(() => settleNode({ strength: NaN, resource: 1, at: 10 }, 20));
  assert.deepEqual(settleNode({ strength: 2, resource: 0.4, at: 100 }, 0), { strength: 2, resource: 0.4, at: 100 });
});

test("novelty uses prior eligible messages, never future messages, with the turn maximum", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const events: StoredEvent[] = [{ type: "message", at, role: "user", requestId: "first", chatId: 42, text: "daily" },
    { type: "message", at, role: "user", requestId: "second", chatId: 42, text: "surgery" }];
  const vector = (text: string) => text === "daily" ? [1, 0] : [0, 1];
  const before = memoryGraph(events.slice(0, 1), 42, vector).states.get("first")!;
  const after = memoryGraph(events, 42, vector);
  assert.equal(before.salience, 0); assert.equal(after.states.get("first")!.salience, 0);
  assert.equal(after.states.get("second")!.salience, 1);
  assert.equal(after.states.get("second")!.strength, DEFAULT_DYNAMICS.strengthCap);
  const late: StoredEvent[] = [{ type: "message", at, role: "user", requestId: "old", chatId: 42, text: "daily" },
    { type: "text_finalized", at, requestId: "old", textSegmentId: "late", contentKind: "final", text: "surgery" },
    { type: "message", at, role: "user", requestId: "next", chatId: 42, text: "daily" },
    { type: "delivery_succeeded", at, requestId: "old" }];
  assert.equal(memoryGraph(late, 42, vector).states.get("next")!.salience, 0);
  assert.equal(memoryGraph(late, 42, vector).states.get("old")!.salience, 1);
});

test("direct evidence is monotone at fixed graph state and remains queryable without short-term resources", () => {
  const node = { id: "old", userId: 42, at: "2020-01-01", messages: [] };
  const graph = { states: new Map([["old", { id: "old", strength: 0, salience: 0, resource: 0, at: 0 }]]), edges: [] };
  const rank = (evidence: number) => rankMemories([{ node, evidence, similarity: evidence, userEvidence: true, sources: ["literal"] }], graph, DEFAULT_DYNAMICS)[0]?.score ?? 0;
  assert.ok(rank(0.9) > rank(0.2)); assert.ok(rank(0.2) > 0); assert.equal(rank(0), 0);
  assert.throws(() => recallConfig({ iterations: 100 }));
});

test("zero-to-positive evidence has no role/resource discontinuity in saturated graph fusion", () => {
  const node = (id: string) => ({ id, userId: 42, at: "2020-01-01", messages: [] });
  for (const resource of [0.5, 1]) {
    const graph = { states: new Map(["seed", "background"].map((id) => [id, { id, strength: 2.1, salience: 0, resource, at: 0 }])),
      edges: [{ from: "seed", to: "background", weight: 2, at: 0 }] };
    const score = (evidence: number) => rankMemories([{ node: node("seed"), evidence: 1, similarity: 0, userEvidence: true, sources: ["literal"] },
      { node: node("background"), evidence, similarity: 0, userEvidence: false, sources: [] }], graph, DEFAULT_DYNAMICS, recallConfig({ maxSeeds: 1 }))
      .find((item) => item.node.id === "background")!.score;
    assert.ok(score(0.35) >= score(0));
  }
});

test("novelty entries respect small total seed budgets", () => {
  const content = Array.from({ length: 10 }, (_value, index) => ({ node: { id: `novel-${index}`, userId: 42, at: "2020-01-01", messages: [] },
    evidence: 0.8, similarity: 0.8, userEvidence: true, sources: ["dense"] }));
  const graph = { states: new Map(content.map((item) => [item.node.id, { id: item.node.id, strength: 3, salience: 1, resource: 1, at: 0 }])), edges: [] };
  for (const maximum of [1, 2, 3]) {
    const results = rankMemories(content, graph, DEFAULT_DYNAMICS, recallConfig({ maxSeeds: maximum }));
    assert.ok(results.filter((item) => item.sources.includes("novel")).length <= maximum);
  }
});
