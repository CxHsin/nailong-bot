import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { diagnoseContext } from "../src/cli/context-diagnostics.js";

test("offline context diagnostics follows the durable active start without changing durable facts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "context-diagnostic-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  for (let index = 0; index < 6; index++) {
    await log.append({ type: "message", role: "user", requestId: `r${index}`, conversationId: "c", text: `PRIVATE-${index}` });
    await log.append({ type: "answer_generated", requestId: `r${index}`, conversationId: "c", text: "SECRET ANSWER" });
    await log.append({ type: "run_succeeded", runId: `r${index}`, requestId: `r${index}`, conversationId: "c", result: { kind: "model" } });
  }
  await log.append({ type: "model_call_started", requestId: "r5", conversationId: "c", callId: "s", purpose: "summary", provider: "test", model: "test" });
  const before = await log.read();
  const bytes = await readFile(join(dir, "runtime-v2.sqlite"));
  const report = await diagnoseContext({ dataDir: dir, conversationId: "c" });
  assert.equal(report.historicalTurns, 4);
  assert.equal(report.selectedMessages, 10);
  assert.equal(report.comparison.legacyMessages, 8);
  assert.equal(report.comparison.activeSourceMessages, 10);
  assert.equal(report.comparison.equal, true);
  assert.equal(report.comparison.warmArchiveRecoveries, 0);
  assert.match(report.comparison.fullDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.simulatedSummaryCalls, 0);
  assert.equal(report.recordedSummaryCalls, 1);
  assert.equal(report.recordedExecutionStarted, false);
  assert.equal(report.exceedsBudget, false);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|SECRET/);
  assert.deepEqual(await log.read(), before);
  assert.deepEqual(await readFile(join(dir, "runtime-v2.sqlite")), bytes);
  const earlier = await diagnoseContext({ dataDir: dir, conversationId: "c", requestId: "r2" });
  assert.equal(earlier.historicalTurns, 2);
  assert.equal(earlier.recordedSummaryCalls, 0);
  await log.append({ type: "model_step_started", requestId: "r5", conversationId: "c", modelStepId: "step", step: 1, purpose: "execution", provider: "test", model: "test" });
  assert.equal((await diagnoseContext({ dataDir: dir, conversationId: "c" })).recordedExecutionStarted, true);
});

test("diagnostics reports an oversized summary input without claiming successful compaction", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "context-diagnostic-large-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  for (let index = 0; index < 4; index++) {
    await log.append({ type: "message", role: "user", requestId: `r${index}`, conversationId: "c", text: "x".repeat(4000) });
    await log.append({ type: "answer_generated", requestId: `r${index}`, conversationId: "c", text: "y".repeat(4000) });
    await log.append({ type: "run_succeeded", runId: `r${index}`, requestId: `r${index}`, conversationId: "c", result: { kind: "model" } });
  }
  const before = await log.read();
  const report = await diagnoseContext({ dataDir: dir, conversationId: "c", contextWindow: 7600 });
  assert.equal(report.exceedsBudget, true);
  assert.equal(report.simulatedSummaryCalls, 0);
  assert.equal(report.simulationSucceeded, false);
  assert.equal(report.simulationFailure, "summary_input_too_large");
  assert.equal(report.recordedSummaryCalls, 0);
  assert.ok(report.projectedEstimatedTokens! > report.budget);
  assert.deepEqual(await log.read(), before);
});

test("context diagnostics reports recorded complete-budget evidence and unknown legacy fields without leaking payloads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "context-evidence-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  await log.append({ type: "message", role: "user", requestId: "r1", conversationId: "c", text: "PRIVATE REQUEST" });
  await log.append({ type: "context_projected", requestId: "r1", conversationId: "c", estimatedTokens: 300, initialTokens: 800,
    budget: 1000, trigger: 700, target: 400, compactionAttempts: 2, releasedTokens: 500, degraded: "candidate_rejected",
    replayMs: 12, replayProcessedEvents: 4, checkpointId: "cp-1", diagnostics: ["SECRET BODY"] });
  await log.append({ type: "compaction_failed", requestId: "r1", conversationId: "c", reason: "candidate_rejected", attempts: 2,
    budget: 1000, target: 400, failureKey: "a".repeat(64), error: "PRIVATE KEY" });
  const report = await diagnoseContext({ dataDir: dir, conversationId: "c" });
  assert.deepEqual(report.recorded.budget, { initialTokens: 800, estimatedTokens: 300, hard: 1000, trigger: 700, target: 400,
    attempts: 2, releasedTokens: 500, degraded: "candidate_rejected", checkpointId: "cp-1", scope: "complete-model-input" });
  assert.deepEqual(report.recorded.recovery, { replayMs: 12, processedEvents: 4 });
  assert.equal(report.recorded.failures[0]!.attempts, 2);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|SECRET/);
  await log.append({ type: "message", role: "user", requestId: "r2", conversationId: "c", text: "new" });
  const old = await diagnoseContext({ dataDir: dir, conversationId: "c" });
  assert.equal(old.recorded.budget.initialTokens, null); assert.equal(old.recorded.budget.scope, "unknown");
});

test("diagnostics keeps simulated checkpoints visible while compacting only temporary state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "context-simulation-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  for (let index = 0; index < 4; index++) {
    await log.append({ type: "message", role: "user", requestId: `r${index}`, conversationId: "c", text: "x".repeat(2200) });
    await log.append({ type: "answer_generated", requestId: `r${index}`, conversationId: "c", text: "y".repeat(2200) });
    await log.append({ type: "run_succeeded", runId: `r${index}`, requestId: `r${index}`, conversationId: "c", result: { kind: "model" } });
  }
  const before = await log.read();
  const report = await diagnoseContext({ dataDir: dir, conversationId: "c", contextWindow: 7600 });
  assert.equal(report.simulationSucceeded, true);
  assert.equal(report.simulatedSummaryCalls, 1);
  assert.ok(report.projectedEstimatedTokens! < report.initialEstimatedTokens);
  assert.deepEqual(await log.read(), before);
});

test("diagnostics never repairs a damaged production archive even when durable events contain its full result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "context-archive-readonly-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  const result = { content: [{ type: "text" as const, text: "PRIVATE ARCHIVE BODY" }], details: {}, isError: false };
  const archive = await log.archive(result);
  await log.append({ type: "message", role: "user", requestId: "r1", conversationId: "c", text: "read" });
  await log.append({ type: "model_message", requestId: "r1", conversationId: "c", modelStepId: "step", message: {
    role: "assistant", content: [{ type: "toolCall", id: "read1", name: "read", arguments: { path: "file" } }], stopReason: "toolUse", timestamp: 0 } });
  await log.append({ type: "tool_dispatch", requestId: "r1", conversationId: "c", toolCallId: "read1", toolName: "read", args: { path: "file" } });
  await log.append({ type: "tool_result", requestId: "r1", conversationId: "c", toolCallId: "read1", toolName: "read", archive, result });
  await log.append({ type: "run_succeeded", runId: "r1", requestId: "r1", conversationId: "c", result: { kind: "model" } });
  await log.append({ type: "message", role: "user", requestId: "r2", conversationId: "c", text: "continue" });
  await writeFile(archive.rawPath, "CORRUPT PRIVATE BODY");
  const before = await log.read();
  await assert.rejects(diagnoseContext({ dataDir: dir, conversationId: "c" }), /归档/);
  assert.equal(await readFile(archive.rawPath, "utf8"), "CORRUPT PRIVATE BODY");
  assert.deepEqual(await log.read(), before);
});
