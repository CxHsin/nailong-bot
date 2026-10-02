import assert from "node:assert/strict";
import test from "node:test";
import { boundedAdd, DEFAULT_DYNAMICS, learningSignal, memoryDynamics, settleNode } from "../src/memory/dynamics.js";
import { graphAt, memoryGraph } from "../src/memory/graph.js";
import type { StoredEvent } from "../src/runtime/runtime-types.js";

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
