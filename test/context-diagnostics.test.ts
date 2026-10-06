import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { diagnoseContext } from "../src/cli/context-diagnostics.js";

test("offline context diagnostics selects recent turns without changing durable facts", async (t) => {
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
  assert.equal(report.historicalTurns, 3);
  assert.equal(report.selectedMessages, 8);
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

test("diagnostics labels oversized recent context and simulated summary calls", async (t) => {
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
  assert.ok(report.simulatedSummaryCalls > 0);
  assert.equal(report.recordedSummaryCalls, 0);
  assert.ok(report.projectedEstimatedTokens <= report.budget);
  assert.deepEqual(await log.read(), before);
});
