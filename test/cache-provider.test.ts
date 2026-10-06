import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { closeFixture } from "./fixtures/cleanup.js";

type Payload = { messages: Array<{ role: string; content: string }>; tools: unknown[]; prompt_cache_key?: string; prompt_cache_retention?: string };
function final(res: ServerResponse, measured = true) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ type: "final", text: "answer" }) }, finish_reason: "stop" }],
    ...(measured ? { usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 5 } } : {}) })}\n\ndata: [DONE]\n\n`);
}

test("real Provider requests preserve prefixes across dates, scope Conversations and report actual usage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cache-provider-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  const seen: Payload[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    seen.push(JSON.parse(body)); final(res, seen.length !== 2);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let now = new Date("2026-10-04T00:00:00Z");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`,
    memoryBootstrap: false, now: () => now });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = createRuntimeLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = async (text: string, conversationId = "c1") => {
    const result = await host.submit({ actor: { id: "owner" }, conversationId, text }).done;
    assert.equal(result.type, "run_succeeded", result.error); return result;
  };
  await send("first");
  now = new Date("2026-10-05T00:00:00Z");
  await send("second");
  assert.deepEqual(seen[1]!.messages.slice(0, seen[0]!.messages.length), seen[0]!.messages);
  assert.deepEqual(seen[1]!.tools, seen[0]!.tools);
  assert.match(JSON.stringify(seen[1]!.messages), /2026-10-05/);
  assert.doesNotMatch(seen[0]!.messages[0]!.content, /Current date:/);
  assert.equal(seen[0]!.prompt_cache_key, undefined);
  assert.equal(seen[0]!.prompt_cache_retention, undefined);
  const report = (await send("/kvcache")).result?.cache as { execution: { hit: number; miss: number; calls: number; measured: number } };
  assert.equal(report.execution.hit, 80);
  assert.equal(report.execution.miss, 20);
  assert.equal(report.execution.calls, 2);
  assert.equal(report.execution.measured, 1);
  await send("foreign", "c2");
  assert.doesNotMatch(JSON.stringify(seen.at(-1)!.messages), /first|second/);
  await send("/reset"); await send("fresh");
  assert.doesNotMatch(JSON.stringify(seen.at(-1)!.messages), /first|second|foreign/);
  await send("/prompt set changed"); await send("after prompt");
  assert.match(seen.at(-1)!.messages[0]!.content, /changed/);
});

test("real compaction calls retain auxiliary usage and measured zero is distinct from missing usage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cache-summary-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  let summaries = 0; let zero = false;
  const summaryInputs: Array<{ previousSummary?: string }> = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload: Payload = JSON.parse(body);
    const isSummary = payload.messages.some((message) => message.content.includes("HISTORY_COMPACTION"));
    if (isSummary) { summaries++; summaryInputs.push(JSON.parse(payload.messages.at(-1)!.content)); }
    const text = isSummary ? "## Goal\nContinue.\n## Progress\nEarlier work completed.\n## Constraints\nKeep requirements.\n## Decisions\nPreserve evidence.\n## Next Steps\nContinue work.\n## Critical Context\nConsult original logs for exact details." : JSON.stringify({ type: "final", text: "answer" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: zero ? 0 : 100, prompt_cache_hit_tokens: zero ? 0 : 80, completion_tokens: zero ? 0 : 5 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false, contextWindow: 7600 });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = createRuntimeLog(dir);
  for (let index = 0; index < 6; index++) {
    await log.append({ type: "message", role: "user", text: `old-${index}:` + "x".repeat(4000), conversationId: "c1" });
    await log.append({ type: "message", role: "assistant", text: "answer:" + "y".repeat(4000), conversationId: "c1" });
  }
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = async (text: string, conversationId = "c1") => {
    const terminal = await host.submit({ actor: { id: "owner" }, conversationId, text }).done;
    assert.equal(terminal.type, "run_succeeded", terminal.error); return terminal;
  };
  await send("continue");
  assert.ok(summaries > 0);
  const report = (await send("/kvcache")).result?.cache as { auxiliary: { calls: number; measured: number; hit: number; miss: number } };
  assert.equal(report.auxiliary.calls, summaries); assert.equal(report.auxiliary.measured, summaries);
  assert.equal(report.auxiliary.hit, 80 * summaries); assert.equal(report.auxiliary.miss, 20 * summaries);
  await log.append({ type: "message", role: "user", text: "other secret", requestId: "other-secret", conversationId: "c2" });
  await send("/forget other-secret", "c2");
  const previousSummaries = summaries;
  await send("continue again");
  assert.ok(summaries > previousSummaries, "the remaining recent originals still require local compaction");
  assert.equal(summaryInputs[previousSummaries]!.previousSummary, undefined,
    "a shifted recent-turn window must not reuse a summary containing an expired turn");
  zero = true; await send("zero", "c2");
  const empty = (await send("/kvcache", "c2")).result?.cache as { execution: { input: number; measured: number; hitRate: number | null } };
  assert.equal(empty.execution.input, 0); assert.equal(empty.execution.measured, 1); assert.equal(empty.execution.hitRate, null);
});

test("actual memory prefixes survive new recall and tools, while forgetting removes quoted originals", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cache-memory-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  const seen: Payload[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload: Payload = JSON.parse(body); seen.push(payload);
    if (payload.messages.at(-1)!.content === "暗号") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ type: "status", text: "temporary UI status" }), tool_calls: [{ index: 0, id: "stable-call", type: "function", function: { name: "ls", arguments: JSON.stringify({ path: "." }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    } else final(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = createRuntimeLog(dir);
  for (const [id, text] of [["old-secret", "暗号是 SECRET-ALPHA"], ["old-color", "颜色是 BLUE-BETA"]]) {
    await log.append({ type: "message", role: "user", conversationId: "c1", requestId: id, text });
    await log.append({ type: "request_completed", conversationId: "c1", requestId: id });
  }
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = async (text: string) => {
    const terminal = await host.submit({ actor: { id: "owner" }, conversationId: "c1", text }).done;
    assert.equal(terminal.type, "run_succeeded", terminal.error); return terminal;
  };
  await send("/reset"); await send("暗号");
  assert.equal(seen.length, 2);
  assert.match(JSON.stringify(seen[0]!.messages), /SECRET-ALPHA/);
  assert.deepEqual(seen[1]!.messages.slice(0, seen[0]!.messages.length), seen[0]!.messages);
  assert.doesNotMatch(JSON.stringify(seen[1]!.messages), /temporary UI status/);
  const previous = seen[1]!.messages;
  await send("颜色");
  assert.deepEqual(seen.at(-1)!.messages.slice(0, previous.length), previous);
  assert.match(JSON.stringify(seen.at(-1)!.messages), /BLUE-BETA/);
  await send("/forget old-secret"); await send("继续");
  assert.doesNotMatch(JSON.stringify(seen.at(-1)!.messages), /SECRET-ALPHA/);
  const before = seen.length;
  const inspection = await send("/memory log old-secret");
  assert.match(String(inspection.result?.text), /SECRET-ALPHA/);
  assert.equal(seen.length, before);
  await send("再继续");
  assert.doesNotMatch(JSON.stringify(seen.at(-1)!.messages), /SECRET-ALPHA/);
});

test("current input keeps its date and memory snapshot after a long tool chain is compacted", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cache-current-compaction-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  await writeFile(join(dir, "source.txt"), "evidence ".repeat(500));
  const executionInputs: Payload[] = [];
  let tools = 0; let summaries = 0;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload: Payload = JSON.parse(body);
    const isSummary = payload.messages.some((message) => message.content?.includes("HISTORY_COMPACTION"));
    if (!isSummary) executionInputs.push(payload);
    if (isSummary) summaries++;
    const text = "## Goal\nContinue.\n## Progress\nEarlier work completed.\n## Constraints\nKeep requirements.\n## Decisions\nPreserve evidence.\n## Next Steps\nContinue work.\n## Critical Context\nConsult original logs for exact details.";
    const delta = isSummary ? { content: text } : tools < 8 ? { tool_calls: [{ index: 0, id: `read-${tools++}`, type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: "source.txt" }) } }] } :
      { content: JSON.stringify({ type: "final", text: "answer" }) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`,
    memoryBootstrap: false, contextWindow: 6000, now: () => new Date("2026-10-04T00:00:00Z") });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = createRuntimeLog(dir);
  await log.append({ type: "message", role: "user", conversationId: "c1", requestId: "secret", text: "暗号是 SECRET-ALPHA" });
  await log.append({ type: "request_completed", conversationId: "c1", requestId: "secret" });
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  await host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "/reset" }).done;
  const terminal = await host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "暗号 inspect all evidence" }).done;
  assert.equal(terminal.type, "run_succeeded", terminal.error);
  assert.ok(summaries > 0);
  assert.match(JSON.stringify(executionInputs[0]!.messages), /SECRET-ALPHA/);
  assert.match(JSON.stringify(executionInputs.at(-1)!.messages), /SECRET-ALPHA/);
  assert.match(JSON.stringify(executionInputs.at(-1)!.messages), /2026-10-04/);
  assert.equal(executionInputs.at(-1)!.messages.filter((message) => message.content === "暗号 inspect all evidence").length, 1);
});
