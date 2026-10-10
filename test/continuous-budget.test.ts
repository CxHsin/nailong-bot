import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { createTestServer } from "./fixtures/http-server.js";
import { closeFixture } from "./fixtures/cleanup.js";

const summary = "## Goal\n继续完成约定的报告。\n## Progress\n已经完成资料检查，完整来源仍在原始记录。\n## Constraints\n必须使用中文；提交前先验证；不要自动部署。\n## Decisions\n采用用户已确认的方案并保留证据。\n## Next Steps\n继续比较候选并形成报告，未完成前不声称成功。\n## Critical Context\n" + "后续可根据原始记录精确核查，不能将不确定执行结果推断为成功。".repeat(10);

test("soft watermark compacts a batch before overflow and keeps the accepted summary across restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "continuous-budget-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  let summaries = 0;
  const inputs: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const summarizing = payload.messages.some((message: { content: string }) => message.content?.includes("HISTORY_COMPACTION"));
    if (summarizing) summaries++; else inputs.push(payload);
    const text = summarizing ? summary : JSON.stringify({ type: "final", text: "继续执行已确认的报告" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options = { outputProtocol: "json-text-v2" as const, dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false, contextWindow: 60000 };
  let agent = await createPiAgent(options);
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = createRuntimeLog(dir);
  let host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = async (text: string) => {
    const result = await host.submit({ actor: { id: "owner" }, conversationId: "c", text }).done;
    assert.equal(result.type, "run_succeeded", result.error);
  };
  await send("任务约束：使用中文、验证后提交、不部署。" + "a".repeat(70000));
  assert.equal(summaries, 0);
  await send("继续比较候选。" + "b".repeat(40000));
  assert.equal(summaries, 1, "batch compaction happens at the soft watermark, before hard overflow");
  assert.match(JSON.stringify(inputs.at(-1)), /必须使用中文/);
  await send("继续下一步");
  assert.equal(summaries, 1, "the released headroom avoids another immediate compaction");
  for (const file of await readdir(join(dir, "checkpoints"), { recursive: true })) {
    if (file.endsWith(".json")) await writeFile(join(dir, "checkpoints", file), "corrupt checkpoint cache");
  }
  await agent.close(); agent = await createPiAgent(options);
  host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  await send("重启后继续");
  assert.equal(summaries, 1, "restart reuses the accepted summary");
  assert.match(JSON.stringify(inputs.at(-1)), /必须使用中文/);
});
test("failed compaction keeps original context, uses at most two attempts and continues within the hard budget", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "failed-budget-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  let summaries = 0;
  const inputs: string[] = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const summarizing = payload.messages.some((message: { content: string }) => message.content?.includes("HISTORY_COMPACTION"));
    if (summarizing) summaries++; else inputs.push(body);
    const text = summarizing ? "invalid incomplete summary" : JSON.stringify({ type: "final", text: "answer" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false, contextWindow: 60000 });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = createRuntimeLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = (text: string) => host.submit({ actor: { id: "owner" }, conversationId: "c", text }).done;
  assert.equal((await send("ORIGINAL-KEEP-ME " + "a".repeat(70000))).type, "run_succeeded");
  assert.equal((await send("CURRENT-KEEP-ME " + "b".repeat(40000))).type, "run_succeeded");
  assert.equal(summaries, 2);
  assert.match(inputs.at(-1)!, /ORIGINAL-KEEP-ME/);
  assert.match(inputs.at(-1)!, /CURRENT-KEEP-ME/);
  assert.equal((await log.read()).filter((event) => event.type === "context_checkpoint_committed").length, 0);
  const diagnostic = (await log.read()).findLast((event) => event.type === "context_projected");
  assert.equal(diagnostic?.degraded, "candidate_rejected");
});
test("a provider overflow after rejected compaction cannot trigger another two attempts for the same input", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "repeat-budget-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  let summaries = 0; let execution = 0;
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    if (body.includes("HISTORY_COMPACTION")) {
      summaries++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "invalid summary" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    } else if (++execution === 2) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "maximum context length exceeded", type: "invalid_request_error" } }));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ type: "final", text: "answer" }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false, contextWindow: 60000 });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = createRuntimeLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = (text: string) => host.submit({ actor: { id: "owner" }, conversationId: "c", text }).done;
  assert.equal((await send("old " + "a".repeat(70000))).type, "run_succeeded");
  assert.equal((await send("current " + "b".repeat(40000))).type, "run_failed");
  assert.equal(summaries, 2, "diagnostic facts and overflow alone cannot unlock repeated compaction");
  assert.equal(execution, 2);
  assert.equal((await log.read()).findLast((event) => event.type === "context_projected")?.degraded, "same_input_failed");
});
test("a configured output allowance reduces the effective hard input budget before Provider dispatch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-headroom-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  let summaries = 0;
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const summarizing = body.includes("HISTORY_COMPACTION");
    if (summarizing) summaries++;
    const text = summarizing ? summary : JSON.stringify({ type: "final", text: "answer" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile, memoryBootstrap: false,
    modelConfiguration: { defaultModel: "test", models: [{ alias: "test", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}`, model: "test", apiKey: "test", contextWindow: 60000, maxTokens: 30000 }] } });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = createRuntimeLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = async (text: string) => { const terminal = await host.submit({ actor: { id: "owner" }, conversationId: "c", text }).done; assert.equal(terminal.type, "run_succeeded", terminal.error); };
  await send("old " + "a".repeat(70000));
  await send("new " + "b".repeat(22000));
  assert.equal((await log.read()).findLast((event) => event.type === "context_projected")?.budget, 30000);
  assert.equal(summaries, 1, "configured output headroom triggers a compaction that ratio alone would miss");
});