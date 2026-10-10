import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "@mariozechner/pi-ai";
import { configuredModel } from "../src/agent/model-config.js";
import { startObservedProvider } from "../src/agent/provider-diagnostics.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { sendResponsesText } from "./fixtures/responses-text.js";
import { createTestServer } from "./fixtures/http-server.js";
import { diagnoseRun } from "../src/cli/run-diagnostics.js";
import { streamNativeResponses } from "../src/agent/native-tool-search.js";

for (const mode of ["sdk", "native"] as const)
for (const scenario of ["sse-error", "response-failed", "socket-reset", "normal"] as const)
  test(`actual Responses ${mode} diagnostic: ${scenario}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "summary-stream-probe-"));
    const server = createTestServer(t, async (req, res) => {
      for await (const _ of req) { /* drain only synthetic input */ }
      if (scenario === "normal") { sendResponsesText(res, "synthetic-message", "final_answer", "Synthetic valid result"); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      setTimeout(() => {
        if (scenario === "socket-reset") res.destroy();
        else res.write(`data: ${JSON.stringify(scenario === "sse-error" ?
          { type: "error", code: "server_error", message: "PRIVATE TOKEN URL" } :
          { type: "response.failed", response: { error: { code: "server_error", message: "PRIVATE TOKEN URL" } } })}\n\n`);
      }, 30);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const model = configuredModel({ alias: "local", api: "openai-responses", model: "gpt-6.1-sol", reasoning: true,
      baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test" });
    const log = await createRuntimeEventLog(dir);
    await log.append({ type: "model_call_started", requestId: "synthetic-run", callId: "synthetic-call", purpose: "summary", provider: model.provider, model: model.id });
    const controller = new AbortController();
    const stream = mode === "sdk" ? streamSimple : (selected: typeof model, context: Parameters<typeof streamSimple>[1], options: Parameters<typeof streamSimple>[2]) =>
      streamNativeResponses(selected, context, options ?? {}, "test", new Set());
    const observed = await startObservedProvider(stream, model, { messages: [{ role: "user", content: "Synthetic summary input", timestamp: 0 }] },
      { apiKey: "test", signal: controller.signal, reasoning: "low", maxTokens: 4096, maxRetries: 0 },
      { id: "synthetic-run", log, signal: controller.signal }, "synthetic-call", "summary");
    for await (const _ of observed.source) { /* actual SDK parser */ }
    const result = await observed.source.result();
    await observed.record(result);
    // Allow the asynchronous Undici cleanup event to settle; production recording may precede it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fact = (await log.read()).find((e) => e.type === "model_transport")!;
    const report = diagnoseRun({ dataDir: dir, runId: "synthetic-run" });
    assert.equal(result.stopReason, scenario === "normal" ? "stop" : "error");
    assert.equal(fact.abortSource, "none");
    if (scenario === "sse-error" || scenario === "response-failed") {
      assert.deepEqual(fact.providerError, { source: mode === "sdk" ? "sdk-message" : "stream-event", code: "server_error",
        eventType: mode === "sdk" ? null : scenario === "sse-error" ? "error" : "response.failed" });
      assert.deepEqual(report.modelSteps[0]!.providerError, fact.providerError);
      if (mode === "sdk") assert.ok((fact.causes as Array<{ name?: string }>).some((cause) => cause.name === "AbortError"));
    } else assert.equal(fact.providerError, null);
    assert.doesNotMatch(JSON.stringify(fact) + JSON.stringify(report), /PRIVATE|TOKEN|URL/);
    t.diagnostic(JSON.stringify({ mode, scenario, stopReason: result.stopReason, httpStatus: fact.httpStatus,
      causes: fact.causes, errorCategory: fact.errorCategory, abortSource: fact.abortSource, publicText: fact.firstPublicTextMs !== null }));
  });
