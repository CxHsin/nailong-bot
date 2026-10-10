import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, getModel } from "@mariozechner/pi-ai";
import { assistantText } from "../src/agent/model-message.js";
import { startObservedProvider } from "../src/agent/provider-diagnostics.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { diagnoseRun } from "../src/cli/run-diagnostics.js";

const model = getModel("openai", "gpt-4o");
for (const failure of ["start", "iteration", "result"] as const) test(`Provider ${failure} exceptions retain safe evidence exactly once`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "provider-observation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  const error = Object.assign(new Error("SECRET TOKEN URL"), { code: "ECONNRESET" });
  const raw = createAssistantMessageEventStream();
  if (failure === "iteration") raw[Symbol.asyncIterator] = async function* () { throw error; };
  if (failure === "result") raw.result = async () => { throw error; };
  await log.append({ type: "model_step_started", requestId: "r", modelStepId: "call" });
  const start = () => startObservedProvider(() => { if (failure === "start") throw error; return raw; }, model, { messages: [] }, {}, { id: "r", log }, "call", "execution");
  if (failure === "start") await assert.rejects(start, /SECRET/);
  else {
    const observed = await start();
    if (failure === "iteration") await assert.rejects(async () => { for await (const _ of observed.source) { /* consume */ } }, /SECRET/);
    else await assert.rejects(() => observed.source.result(), /SECRET/);
    await observed.record(assistantText("PRIVATE", model));
  }
  const facts = (await log.read()).filter((e) => e.type === "model_transport");
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0]!.causes, [{ name: "Error", code: "ECONNRESET" }]);
  const report = diagnoseRun({ dataDir: dir, runId: "r" });
  assert.equal(report.modelSteps[0]!.normalTerminal, false);
  assert.equal(report.modelSteps[0]!.terminalEventMs, null);
  assert.doesNotMatch(JSON.stringify(facts) + JSON.stringify(report), /SECRET|PRIVATE/);
});

for (const source of ["run", "provider", "timeout"] as const) test(`${source} signal cancellation is distinguished from an internal AbortError`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "provider-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  const run = new AbortController(); const provider = new AbortController();
  // The Agent forwards a Run abort before the diagnostic Run listener executes.
  run.signal.addEventListener("abort", () => provider.abort(new Error("PRIVATE REASON")));
  const raw = createAssistantMessageEventStream();
  const observed = await startObservedProvider(() => raw, model, { messages: [] }, { signal: provider.signal, timeoutMs: 900 },
    { id: "r", log, signal: run.signal }, "call", "execution");
  if (source === "run") run.abort(new Error("PRIVATE REASON"));
  else provider.abort(source === "timeout" ? new DOMException("SECRET", "TimeoutError") : new Error("PRIVATE REASON"));
  const message = assistantText("", model); message.stopReason = "aborted";
  raw.push({ type: "error", reason: "aborted", error: message });
  for await (const _ of observed.source) { /* consume */ }
  await observed.record(await observed.source.result());
  const fact = (await log.read()).find((e) => e.type === "model_transport")!;
  assert.equal(fact.abortSource, source === "timeout" ? "timeout-signal" : `${source}-signal`);
  assert.equal(fact.normalTerminal, false); assert.equal(fact.configuredTimeoutMs, 900);
  assert.ok(typeof fact.abortMs === "number"); assert.ok(typeof fact.terminalEventMs === "number");
  assert.doesNotMatch(JSON.stringify(fact), /PRIVATE|SECRET/);
});

test("SDK start and thinking do not imply public text or an application cancellation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "provider-thinking-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir); const raw = createAssistantMessageEventStream();
  const observed = await startObservedProvider(() => raw, model, { messages: [] }, {}, { id: "r", log }, "call", "summary");
  const message = assistantText("", model); message.stopReason = "error";
  raw.push({ type: "start", partial: message });
  raw.push({ type: "thinking_delta", contentIndex: 0, delta: "PRIVATE THINKING", partial: message });
  raw.push({ type: "text_delta", contentIndex: 1, delta: "", partial: message });
  raw.push({ type: "error", reason: "error", error: message });
  for await (const _ of observed.source) { /* consume */ }
  const fact = (await log.read()).find((e) => e.type === "model_transport")!;
  assert.ok(typeof fact.firstStreamEventMs === "number"); assert.equal(fact.firstPublicTextMs, null);
  assert.equal(fact.abortSource, "none"); assert.equal(fact.errorCategory, "unknown");
  assert.doesNotMatch(JSON.stringify(fact), /PRIVATE/);
});
