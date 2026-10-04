import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProgressPipeline, projectProgress, type ProgressEvent } from "../src/runtime/progress.js";
import { createDeliveryFactStore, reduceRunDelivery } from "../src/runtime/delivery-pipeline.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";

test("progress events carry semantic identity and durable facts exclude deltas", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "progress-pipeline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  const pipeline = createProgressPipeline({ log, maxSilenceMs: 20 });
  const first = await pipeline.emit("run-1", "conversation-1", { kind: "tool_started", phase: "tool", source: "runtime", visibility: "normal", contextPolicy: "exclude", identity: "tool-1" });
  await pipeline.emit("run-1", "conversation-1", { kind: "delta", phase: "model", source: "provider", visibility: "verbose", contextPolicy: "exclude", durable: false });
  const second = await pipeline.emit("run-1", "conversation-1", { kind: "terminal", phase: "terminal", source: "runtime", visibility: "always", contextPolicy: "exclude", resultId: "result-1" });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 3);
  const durable = await log.read();
  assert.equal(durable.filter((event) => event.kind === "delta").length, 0);
  assert.equal(projectProgress([first, second], "quiet").map((event) => event.kind).join(","), "terminal");
});

test("normal mode emits a fallback when meaningful progress goes silent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "progress-silence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  const pipeline = createProgressPipeline({ log, maxSilenceMs: 10 });
  await pipeline.emit("run-1", "conversation-1", { kind: "tool_started", phase: "tool", source: "runtime", visibility: "normal", contextPolicy: "exclude" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const events = await pipeline.events("run-1");
  assert.ok(events.some((event) => event.kind === "silence_fallback"));
  pipeline.stop("run-1");
});

test("Run and Delivery facts remain separate and idempotent across recovery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "delivery-facts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  const delivery = createDeliveryFactStore(log);
  await delivery.recordAttempt({ resultId: "result-1", channel: "cli", target: "stdout", idempotencyKey: "result-1:cli" });
  await delivery.recordOutcome("result-1", "cli", "unknown", { error: "timeout" });
  await delivery.recordAttempt({ resultId: "result-1", channel: "cli", target: "stdout", idempotencyKey: "result-1:cli" });
  const state = reduceRunDelivery(await log.read(), "run-1", "result-1");
  assert.equal(state.delivery.get("result-1:cli")?.outcome, "unknown");
  assert.equal(state.resultReusable, true);
  assert.equal((await log.read()).filter((event) => event.type === "delivery_attempt").length, 1);
});
