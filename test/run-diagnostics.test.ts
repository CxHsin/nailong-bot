import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { diagnoseRun } from "../src/cli/run-diagnostics.js";

test("run diagnostics isolates a failed Run, redacts payloads and leaves durable data unchanged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "run-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  const fact = (type: string, fields = {}) => log.append({ type, requestId: "r", conversationId: "c", ...fields });
  await fact("run_started", { runId: "r" });
  await fact("message", { role: "user", text: "PRIVATE PROMPT" });
  await fact("capability_snapshot", { mode: "compat", tools: [{ description: "SECRET SCHEMA" }] });
  await fact("context_projected", { estimatedTokens: 58177, budget: 110080 });
  await fact("model_step_started", { modelStepId: "step", step: 1, purpose: "execution", provider: "test", model: "test" });
  await fact("model_transport", { callId: "step", purpose: "execution", provider: "test", model: "test", httpStatus: 200,
    providerRequestId: "req_test", elapsedMs: 42, errorCategory: "stream_terminated", causes: [{ name: "SocketError", code: "UND_ERR_SOCKET" }], stopReason: "error" });
  await fact("model_message", { modelStepId: "step", message: { role: "assistant", content: [{ type: "text", text: "SECRET DRAFT" }], stopReason: "error", errorMessage: "terminated" } });
  await fact("tool_result", { toolCallId: "tool", toolName: "write", result: { content: [{ type: "text", text: "SECRET RESULT" }], details: {}, isError: false } });
  await fact("run_failed", { runId: "r", error: "SECRET ERROR" });
  await log.append({ type: "run_failed", runId: "other", error: "PRIVATE OTHER" });
  const before = await readFile(join(dir, "runtime-v2.sqlite"));
  const report = diagnoseRun({ dataDir: dir, runId: "r" });
  assert.equal(report.state, "failed");
  assert.equal(report.mode, "compat");
  assert.deepEqual(report.context, { estimatedTokens: 58177, budget: 110080, exceedsBudget: false });
  assert.deepEqual(report.tools, { results: 1, errors: 0 });
  assert.equal(report.modelSteps.length, 1);
  assert.equal(report.modelSteps[0]!.errorCategory, "stream_terminated");
  assert.equal(report.modelSteps[0]!.httpStatus, 200);
  assert.deepEqual(report.modelSteps[0]!.causes, [{ name: "SocketError", code: "UND_ERR_SOCKET" }]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|SECRET/);
  assert.deepEqual(await readFile(join(dir, "runtime-v2.sqlite")), before);
  assert.throws(() => diagnoseRun({ dataDir: dir, runId: "missing" }), /Run/);
});

test("old Runs report absent transport evidence and never print arbitrary error messages", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "run-diagnostics-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  await log.append({ type: "model_step_started", requestId: "old", modelStepId: "s", step: 1, purpose: "execution", provider: "test", model: "test" });
  await log.append({ type: "model_message", requestId: "old", modelStepId: "s", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "PRIVATE https://user:password@example.com/?token=SECRET" } });
  await log.append({ type: "run_failed", runId: "old" });
  const report = diagnoseRun({ dataDir: dir, runId: "old" });
  assert.equal(report.modelSteps[0]!.httpStatus, null);
  assert.equal(report.modelSteps[0]!.errorCategory, "unknown");
  assert.deepEqual(report.modelSteps[0]!.causes, []);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|SECRET|password/);
});
