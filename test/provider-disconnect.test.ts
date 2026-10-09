import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { createTelegramHostProjection } from "../src/channel/telegram/index.js";
import { createTestServer } from "./fixtures/http-server.js";
import { closeFixture } from "./fixtures/cleanup.js";
import { diagnoseRun } from "../src/cli/run-diagnostics.js";

async function disconnect(t: TestContext, mode: "compat" | "native") {
  const dir = await mkdtemp(join(tmpdir(), "provider-disconnect-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent");
  let calls = 0;
  let received!: () => void;
  const partialReceived = new Promise<void>((resolve) => { received = resolve; });
  const server = createTestServer(t, async (req, res) => {
    for await (const _ of req) { /* drain */ }
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": `req_${mode}_${calls}`, "authorization": "SECRET RESPONSE HEADER" });
    const emit = (type: string, fields: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit("response.created", { response: { id: `resp_${calls}` } });
    if (calls === 1) {
      const item = { type: "function_call", id: "fc_write", call_id: "call_write", name: "write", arguments: '{"path":"once.txt","content":"ONCE"}', status: "completed" };
      emit("response.output_item.added", { output_index: 0, item });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 10 } } });
      res.end();
    } else {
      emit("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg", role: "assistant", content: [] } });
      emit("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      emit("response.output_text.delta", { output_index: 0, content_index: 0, delta: "PARTIAL ANSWER" });
      await partialReceived; // Disconnect only after the real client received and previewed the draft.
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, modelConfiguration: { defaultModel: "test", models: [{ alias: "test", api: "openai-responses", model: "test", apiKey: "SECRET REQUEST KEY", baseUrl: `http://127.0.0.1:${address.port}`, toolSearch: mode }] } });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = await createRuntimeEventLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const sent: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42, draftIntervalMs: 1,
    draft: async (_id, text) => { if (text.includes("PARTIAL ANSWER")) received(); },
    send: async (text) => { sent.push(text); return 1; } });
  const run = host.submit({ actor: { id: "owner" }, conversationId: "c", text: "write then answer" });
  await projection.consume(run);
  assert.equal((await run.done).type, "run_failed");
  assert.equal(calls, 2);
  assert.equal(await readFile(join(dir, "once.txt"), "utf8"), "ONCE");
  const events = await log.read();
  assert.equal(events.filter((e) => e.type === "tool_dispatch" && e.toolName === "write").length, 1);
  assert.equal(events.some((e) => e.type === "text_finalized" && e.contentKind === "final"), false);
  assert.equal(events.some((e) => e.type === "answer_generated"), false);
  assert.equal(sent.some((text) => text.includes("PARTIAL ANSWER")), false);
  assert.match(sent.at(-1)!, /处理失败/);
  const runId = String(events.find((e) => e.type === "run_started")!.runId);
  const report = diagnoseRun({ dataDir: dir, runId });
  const last = report.modelSteps.at(-1)!;
  assert.equal(last.httpStatus, 200);
  assert.equal(last.providerRequestId, `req_${mode}_2`);
  assert.equal(last.errorCategory, "stream_terminated");
  assert.ok(last.elapsedMs! >= 0);
  assert.ok(last.causes.some((cause) => cause.code === "UND_ERR_SOCKET"));
  assert.equal(last.causes.filter((cause) => cause.code === "UND_ERR_SOCKET").length, 1);
  assert.equal(report.modelSteps[0]!.causes.length, 0);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|PARTIAL ANSWER/);
}

test("concurrent Responses disconnects isolate evidence, discard drafts and never repeat a tool", { concurrency: true, timeout: 12000 }, async (t) => {
  const modes = ["compat", "native"] as const;
  await Promise.all(modes.map((mode) => t.test(mode, (child) => disconnect(child, mode))));
});

for (const mode of ["compat", "native"] as const) test(`${mode} HTTP rejection retains status and request ID without leaking the response body`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "provider-rejection-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent");
  let calls = 0;
  const server = createTestServer(t, async (req, res) => {
    for await (const _ of req) { /* drain */ }
    calls++; res.writeHead(503, { "content-type": "application/json", "x-request-id": "req_rejected" }).end('{"error":{"message":"SECRET BODY"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, modelConfiguration: { defaultModel: "test", models: [{ alias: "test", api: "openai-responses", model: "test", apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}`, toolSearch: mode }] } });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  assert.equal((await host.submit({ actor: { id: "owner" }, conversationId: "c", text: "answer" }).done).type, "run_failed");
  const runId = String((await log.read()).find((e) => e.type === "run_started")!.runId);
  const report = diagnoseRun({ dataDir: dir, runId });
  assert.equal(calls, 1);
  assert.equal(report.modelSteps[0]!.httpStatus, 503);
  assert.equal(report.modelSteps[0]!.providerRequestId, "req_rejected");
  assert.doesNotMatch(JSON.stringify(report), /SECRET BODY/);
});
