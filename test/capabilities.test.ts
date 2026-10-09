import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { createTestServer } from "./fixtures/http-server.js";

function completion(res: import("node:http").ServerResponse, name?: string, args = {}, text = "done") {
  const delta = name ? { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { content: text };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}

function response(res: import("node:http").ServerResponse, item: Record<string, unknown>) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("response.created", { response: { id: "resp_test" } });
  emit("response.output_item.added", { output_index: 0, item });
  if (item.type === "message") emit("response.output_text.delta", { output_index: 0, content_index: 0, delta: "native done" });
  emit("response.output_item.done", { output_index: 0, item });
  emit("response.completed", { response: { status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 20 } } } });
  res.end();
}

test("native Responses loads schemas via tool_search_output while declarations stay stable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "native-search-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent");
  const wire: any[] = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk; const data = JSON.parse(body); wire.push(data);
    if (wire.length === 1) response(res, { type: "tool_search_call", id: "ts_1", call_id: "search_1", execution: "client", status: "completed", arguments: { query: "ls", limit: 1 } });
    else if (wire.length === 2) {
      assert.equal(data.input.find((item: any) => item.type === "tool_search_call").execution, "client");
      assert.equal(data.input.find((item: any) => item.type === "tool_search_output").tools[0].name, "ls");
      response(res, { type: "function_call", id: "fc_ls", call_id: "ls_1", name: "ls", arguments: '{"path":"."}', status: "completed" });
    } else if (wire.length === 4) {
      assert.equal(data.input.some((item: any) => item.type === "tool_search_output" || item.type === "tool_search_call"), false);
      response(res, { type: "function_call", id: "fc_ls2", call_id: "ls_2", name: "ls", arguments: '{"path":"."}', status: "completed" });
    } else {
      if (wire.length === 5) assert.match(data.input.at(-1).output, /未发现/);
      response(res, { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "native done" }] });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, modelConfiguration: { defaultModel: "native", models: [{ alias: "native", api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}`, model: "test-native", apiKey: "test", toolSearch: "native" }] } });
  t.after(() => agent.close()); const log = await createRuntimeEventLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const done = await host.submit({ actor: { id: "owner" }, conversationId: "c", text: "list files" }).done;
  assert.equal(done.type, "run_succeeded", JSON.stringify(done));
  assert.equal(done.result?.text, "native done");
  assert.equal(wire[0].tools[0].type, "tool_search");
  assert.equal(wire[0].tools[0].execution, "client");
  assert.equal(wire[0].tools.some((tool: any) => tool.name === "ls" || tool.name === "tool_call"), false);
  assert.ok(wire.every((data) => JSON.stringify(data.tools) === JSON.stringify(wire[0].tools)));
  assert.equal((await log.read()).filter((event) => event.type === "capability_executed" && event.toolName === "ls").length, 1);
  assert.equal((await host.submit({ actor: { id: "owner" }, conversationId: "c", text: "new Run" }).done).type, "run_succeeded");
  assert.equal((await log.read()).filter((event) => event.type === "capability_executed" && event.toolName === "ls").length, 1);
});

test("native Anthropic searches with tool_reference and retains deferred declarations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "anthropic-search-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent"); const wire: any[] = [];
  const server = createTestServer(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; const data = JSON.parse(raw); wire.push(data);
    const step = wire.length;
    if (step === 2) assert.ok(JSON.stringify(data.messages).includes('"type":"tool_reference","tool_name":"ls"'));
    const tool = step === 1 ? { name: "tool_search", args: { query: "ls", limit: 1 } } : step === 2 ? { name: "ls", args: { path: "." } } : undefined;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`);
    emit("message_start", { message: { id: `msg_${step}`, type: "message", role: "assistant", content: [], model: "claude-test", usage: { input_tokens: 10, output_tokens: 0 } } });
    emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `call_${step}`, name: tool.name, input: {} } : { type: "text", text: "" } });
    emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.args) } : { type: "text_delta", text: "anthropic done" } });
    emit("content_block_stop", { index: 0 }); emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }); emit("message_stop", {}); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, modelConfiguration: { defaultModel: "claude", models: [{ alias: "claude", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${address.port}`, model: "claude-test", apiKey: "test", toolSearch: "native" }] } });
  t.after(() => agent.close()); const log = await createRuntimeEventLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const done = await host.submit({ actor: { id: "owner" }, conversationId: "c", text: "list" }).done;
  assert.equal(done.type, "run_succeeded", JSON.stringify(done)); assert.equal(done.result?.text, "anthropic done");
  assert.equal(wire[0].tools.find((tool: any) => tool.name === "ls").defer_loading, true);
  assert.ok(wire.every((data) => JSON.stringify(data.tools) === JSON.stringify(wire[0].tools)));
  assert.doesNotMatch(JSON.stringify(await log.read()), /tool_reference/);
});

test("Host discovers colliding MCP tools by source and an unavailable MCP leaves local tools usable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-catalog-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent"); let executions = 0; let calls = 0;
  const longName = "x".repeat(60);
  const server = createTestServer(t, async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let raw = ""; for await (const chunk of req) raw += chunk; const data = JSON.parse(raw);
    if (req.url === "/offline") { res.writeHead(503).end(); return; }
    if (req.url === "/mcp") {
      let result: unknown;
      if (data.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
      else if (data.method === "tools/list") result = { tools: ["read", longName].map((name) => ({ name, description: "Read remote widget", inputSchema: { type: "object", properties: { widget: { type: "string", description: "widget identifier" } }, required: ["widget"], additionalProperties: false } })) };
      else if (data.method === "tools/call") { executions++; assert.ok(["read", longName].includes(data.params.name)); result = { content: [{ type: "text", text: "REMOTE WIDGET" }] }; }
      else { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: data.id, result })); return;
    }
    if (++calls === 1) completion(res, "tool_search", { query: "widgets__read", limit: 1 });
    else if (calls === 2) { assert.match(data.messages.at(-1).content, /widgets__read/); completion(res, "tool_call", { name: "widgets__read", arguments: { widget: "one" } }); }
    else if (calls === 3) { assert.match(data.messages.at(-1).content, /REMOTE WIDGET/); completion(res, "write", { path: "local.txt", content: "LOCAL" }); }
    else if (calls === 5) completion(res, "tool_search", { query: longName, limit: 2 });
    else if (calls === 6) {
      const tools = JSON.parse(data.messages.at(-1).content).tools;
      assert.equal(tools.length, 2); assert.ok(tools.every((tool: any) => tool.name.length <= 64 && tool.originalName === longName));
      assert.deepEqual(tools.map((tool: any) => tool.source).sort(), ["more", "widgets"]);
      completion(res, "tool_call", { name: tools[0].name, arguments: { widget: "long-name" } });
    } else completion(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, deepseekKey: "test", modelBaseUrl: base,
    mcpServers: [{ name: "widgets", url: `${base}/mcp` }, { name: "more", url: `${base}/mcp` }, { name: "offline", url: `${base}/offline`, timeoutMs: 1000 }] });
  t.after(() => agent.close()); const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const result = await host.submit({ actor: { id: "owner" }, conversationId: "c", text: "read widget then save" }).done;
  assert.equal(result.type, "run_succeeded", JSON.stringify(result)); assert.equal(executions, 1);
  assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "local.txt"), "utf8")), "LOCAL");
  assert.deepEqual((await log.read()).find((event) => event.type === "capability_snapshot")?.unavailableSources, ["offline"]);
  assert.equal((await host.submit({ actor: { id: "owner" }, conversationId: "c", text: "use long remote tool" }).done).type, "run_succeeded");
  assert.equal(executions, 2);
});

test("Host discovers tools once per Run, validates calls and keeps the stable wire prefix", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "capabilities-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "personal agent");
  const wire: any[] = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); wire.push(data);
    const step = wire.length;
    if (step === 1) completion(res, "tool_call", { name: "ls", arguments: { path: "." } });
    else if (step === 2) { assert.match(data.messages.at(-1).content, /未发现/); completion(res, "tool_search", { query: "ls" }); }
    else if (step === 3) { assert.match(data.messages.at(-1).content, /parameters/); completion(res, "tool_call", { name: "ls", arguments: { path: 7 } }); }
    else if (step === 4) { assert.match(data.messages.at(-1).content, /参数|validation|Expected/i); completion(res, "tool_call", { name: "ls", arguments: { path: "." } }); }
    else if (step === 5) { assert.match(data.messages.at(-1).content, /prompt.md/); completion(res, "tool_call", { name: "ls", arguments: { path: "." } }); }
    else completion(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const log = await createRuntimeEventLog(dir);
  const agent = await createPiAgent({ dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false });
  t.after(() => agent.close());
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const done = await host.submit({ actor: { id: "owner" }, conversationId: "c", text: "list files" }).done;
  assert.equal(done.type, "run_succeeded", JSON.stringify((await log.read()).filter((event) => event.type === "request_failed" || event.type === "tool_result")));
  assert.deepEqual(wire[0].tools.map((tool: any) => tool.function.name), ["tool_search", "read", "write", "edit", "web_search", "tool_call"]);
  assert.ok(wire.every((data) => JSON.stringify(data.tools) === JSON.stringify(wire[0].tools)));
  assert.ok(wire.every((data) => JSON.stringify(data.messages[0]) === JSON.stringify(wire[0].messages[0])));
  const events = await log.read();
  assert.equal(events.filter((e) => e.type === "tool_discovered").length, 1);
  assert.equal(events.filter((e) => e.type === "capability_executed" && e.toolName === "ls").length, 2);
});

test("Host installs only on an explicit request, preserves resources and supports atomic updates after restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "skills-install-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent");
  let version = "OLD"; let broken = false; let downloads = 0;
  const skillFetch: typeof fetch = async (input) => {
    downloads++; const url = String(input);
    if (url.includes("/commits/")) return url.endsWith("/commits/main") ? Response.json({ sha: version === "OLD" ? "a".repeat(40) : "b".repeat(40) }) : new Response("missing", { status: 404 });
    if (url.includes("/git/trees/")) return Response.json({ tree: [
      { path: "skills/demo/SKILL.md", type: "blob", mode: "100644" }, { path: "skills/demo/reference.txt", type: "blob", mode: "100644" },
      { path: "skills/demo/scripts/run.js", type: "blob", mode: "100644" },
    ] });
    if (url.endsWith("SKILL.md")) return new Response(broken ? "bad" : `---\nname: demo\ndescription: Demo workflow\n---\n${version} instruction`);
    if (url.endsWith("reference.txt")) return new Response("REFERENCE");
    if (url.endsWith("run.js")) return new Response("throw new Error('must never run on install')");
    return new Response("missing", { status: 404 });
  };
  let modelCalls = 0;
  const server = createTestServer(t, async (req, res) => { for await (const _chunk of req) {} modelCalls++; completion(res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options = { dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false, skillFetch };
  const log = await createRuntimeEventLog(dir); let agent = await createPiAgent(options);
  let host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = (text: string) => host.submit({ actor: { id: "owner" }, conversationId: "c", text, metadata: { channel: "telegram" } }).done;
  const url = "https://github.com/owner/repo/tree/main/skills/demo";
  await send(url); assert.equal(downloads, 0); assert.equal(modelCalls, 1);
  const result = await send(`安装 skill ${url}`); assert.match(String(result.result?.text), /已安装.*demo/);
  const installed = (await log.read()).find((e) => e.type === "skill_installed")!;
  assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(join(String(installed.root), "reference.txt"), "utf8")), "REFERENCE");
  const count = modelCalls; await send("@demo use it"); assert.equal(modelCalls, count + 1);
  assert.match(String((await send(`安装 skill ${url}`)).result?.text), /已存在|重名/);
  version = "NEW"; broken = true;
  assert.match(String((await send(`更新 skill ${url}`)).result?.text), /失败|元数据/);
  await agent.close(); agent = await createPiAgent(options); t.after(() => agent.close());
  host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  assert.equal((await send("@demo restart")).type, "run_succeeded");
  broken = false; assert.match(String((await send(`更新 skill ${url}`)).result?.text), /已更新.*demo/);
  const loaded = (await log.read()).filter((e) => e.type === "skill_loaded");
  assert.ok(loaded.every((e) => String(e.body).includes("OLD instruction")));
});

test("Telegram loads explicit skills in order, persists full bodies and replays the loaded version", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "skills-host-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "source"); await mkdir(join(root, "lesson"), { recursive: true });
  const path = join(root, "lesson", "SKILL.md");
  const body = "---\nname: lesson\ndescription: Teach a lesson\n---\n" + "step instruction\n".repeat(450) + "END-OLD-SKILL";
  await writeFile(path, body);
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "personal agent");
  const wire: any[] = [];
  const server = createTestServer(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; wire.push(JSON.parse(raw)); completion(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options = { dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false,
    skillSources: [{ name: "personal", path: root }] };
  const log = await createRuntimeEventLog(dir);
  let agent = await createPiAgent(options);
  let host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = (text: string) => host.submit({ actor: { id: "owner" }, conversationId: "c", text, metadata: { channel: "telegram" } }).done;
  await send("hello");
  assert.match(JSON.stringify(wire[0].messages[0]), /Teach a lesson/);
  assert.doesNotMatch(JSON.stringify(wire[0]), /END-OLD-SKILL/);
  const result = await send("@lesson @lesson 教我"); assert.equal(result.type, "run_succeeded");
  assert.match(JSON.stringify(wire[1]), /END-OLD-SKILL/);
  assert.match(JSON.stringify(wire[1]), /@lesson @lesson/);
  assert.equal((await log.read()).filter((e) => e.type === "skill_loaded").length, 1);
  await agent.close(); await writeFile(path, body.replace("END-OLD-SKILL", "END-NEW-SKILL"));
  agent = await createPiAgent(options); t.after(() => agent.close());
  host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  await send("continue");
  assert.match(JSON.stringify(wire[2]), /END-OLD-SKILL/);
  assert.doesNotMatch(JSON.stringify(wire[2]), /END-NEW-SKILL/);
  const before = wire.length;
  const missing = await send("@unknown 教我");
  assert.match(JSON.stringify(missing), /未知.*skill|未知.*技能/); assert.equal(wire.length, before);
  await send("/reset"); await send("fresh"); assert.doesNotMatch(JSON.stringify(wire.at(-1)), /END-OLD-SKILL|END-NEW-SKILL/);
});

test("implicit skill selection reads every page and resolves only the requested relative resource", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "skill-pages-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "skills-source"); const skillRoot = join(root, "lesson"); await mkdir(skillRoot, { recursive: true });
  const path = join(skillRoot, "SKILL.md");
  await writeFile(path, "---\nname: lesson\ndescription: Teach a lesson\n---\n" + "instruction\n".repeat(300) + "FINAL INSTRUCTION");
  await writeFile(join(skillRoot, "reference.txt"), "REQUESTED RESOURCE"); await writeFile(join(skillRoot, "unused.txt"), "UNREQUESTED RESOURCE");
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent"); let calls = 0;
  const server = createTestServer(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; const data = JSON.parse(raw); calls++;
    const last = data.messages.at(-1);
    if (calls === 1) { assert.doesNotMatch(raw, /FINAL INSTRUCTION|REQUESTED RESOURCE/); completion(res, "read", { path }); }
    else if (calls === 2 || calls === 3) {
      assert.match(last.content, /尚未加载完整/); const continuation = JSON.parse(last.content.match(/read\((\{.*?\})\)/)[1]); completion(res, "read", continuation);
    } else if (calls === 4) { assert.match(last.content, /FINAL INSTRUCTION/); completion(res, "read", { path: "reference.txt" }); }
    else { assert.match(last.content, /REQUESTED RESOURCE/); assert.doesNotMatch(raw, /UNREQUESTED RESOURCE/); completion(res); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, skillSources: [{ name: "source", path: root }] });
  t.after(() => agent.close()); const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const result = await host.submit({ actor: { id: "owner" }, conversationId: "c", text: "teach" }).done;
  assert.equal(result.type, "run_succeeded", JSON.stringify(result));
  const loaded = (await log.read()).filter((event) => event.type === "skill_read"); assert.deepEqual(loaded.map((event) => event.complete), [false, false, true]);
});

test("explicit skill over budget fails before Provider instead of truncating instructions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "skill-budget-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "source"); await mkdir(join(root, "huge"), { recursive: true });
  await writeFile(join(root, "huge", "SKILL.md"), "---\nname: huge\ndescription: Huge instructions\n---\n" + "instruction ".repeat(10000));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent"); let calls = 0;
  const server = createTestServer(t, (_req, res) => { calls++; completion(res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, contextWindow: 9000, skillSources: [{ name: "source", path: root }] });
  t.after(() => agent.close()); const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const result = await host.submit({ actor: { id: "owner" }, conversationId: "c", text: "@huge execute", metadata: { channel: "telegram" } }).done;
  assert.match(String(result.result?.text), /skill 加载失败.*预算/); assert.equal(calls, 0);
});

test("single-file installs reject damaged metadata and unsupported URLs without partial skills", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "skill-errors-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent");
  let mode = "invalid"; let calls = 0;
  const skillFetch: typeof fetch = async () => {
    if (mode === "missing") return new Response("missing", { status: 404 });
    return new Response(mode === "invalid" ? "---\nname: ../escape\ndescription: broken\n---\nbody" : "---\nname: solo\ndescription: Single file\n---\nINSTRUCTION");
  };
  const server = createTestServer(t, async (req, res) => { for await (const _chunk of req) {} calls++; completion(res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, skillFetch });
  t.after(() => agent.close()); const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = (text: string) => host.submit({ actor: { id: "owner" }, conversationId: "c", text, metadata: { channel: "telegram" } }).done;
  assert.match(String((await send("安装 skill https://example.com/skill.zip")).result?.text), /不支持/);
  assert.match(String((await send("安装 skill https://example.com/SKILL.md")).result?.text), /名称/);
  mode = "missing"; assert.match(String((await send("安装 skill https://example.com/SKILL.md")).result?.text), /HTTP 404/);
  assert.equal((await log.read()).some((e) => e.type === "skill_installed"), false);
  mode = "valid"; assert.match(String((await send("/skill install https://example.com/SKILL.md")).result?.text), /仅含 SKILL.md/);
  assert.equal(calls, 0); assert.equal((await send("@solo use")).type, "run_succeeded"); assert.equal(calls, 1);
});

test("qualified references resolve ambiguity, deduplicate aliases and load in input order", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "skill-names-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = join(dir, "first"); const second = join(dir, "second");
  for (const [root, name] of [[first, "demo"], [first, "other"], [second, "demo"]]) {
    await mkdir(join(root!, name!), { recursive: true }); await writeFile(join(root!, name!, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} workflow\n---\n${root} body`);
  }
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent"); let calls = 0;
  const server = createTestServer(t, async (req, res) => { for await (const _chunk of req) {} calls++; completion(res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, skillSources: [{ name: "first", path: first }, { name: "second", path: second }] });
  t.after(() => agent.close()); const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = (text: string) => host.submit({ actor: { id: "owner" }, conversationId: "c", text, metadata: { channel: "telegram" } }).done;
  assert.match(String((await send("@demo use")).result?.text), /歧义.*@first:demo.*@second:demo/); assert.equal(calls, 0);
  assert.equal((await send("@second:demo @other @first:other @first:demo execute")).type, "run_succeeded");
  assert.deepEqual((await log.read()).filter((e) => e.type === "skill_loaded").map((e) => `${e.source}:${e.name}`), ["second:demo", "first:other", "first:demo"]);
});

test("skill scripts run only through a configured discovered execution tool", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "skill-exec-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "source"); const skillRoot = join(root, "scripted"); await mkdir(join(skillRoot, "scripts"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: scripted\ndescription: Run a script\n---\nRead scripts/run.js then execute through the configured tool.");
  const script = join(skillRoot, "scripts", "run.js"); await writeFile(script, "console.log('SCRIPT OUTPUT')");
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent"); let calls = 0; let configured = true;
  const server = createTestServer(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; const data = JSON.parse(raw);
    if (++calls === 1) completion(res, "read", { path: "scripts/run.js" });
    else if (calls === 2) { assert.match(data.messages.at(-1).content, /console.log/); completion(res, "tool_search", { query: "bash", limit: 1 }); }
    else if (configured && calls === 3) completion(res, "tool_call", { name: "bash", arguments: { command: `node '${script.replaceAll("\\", "/")}'` } });
    else { if (configured) assert.match(data.messages.at(-1).content, /SCRIPT OUTPUT/); else assert.match(data.messages.at(-1).content, /"tools":\[\]/); completion(res, undefined, {}, configured ? "script succeeded" : "没有配置执行工具"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options = { dataDir: dir, promptFile, memoryBootstrap: false, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, skillSources: [{ name: "source", path: root }] };
  const log = await createRuntimeEventLog(dir); let agent = await createPiAgent({ ...options, executionTool: true });
  let host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = () => host.submit({ actor: { id: "owner" }, conversationId: "c", text: "@scripted run", metadata: { channel: "telegram" } }).done;
  assert.equal((await send()).result?.text, "script succeeded");
  assert.equal((await log.read()).filter((e) => e.type === "capability_executed" && e.toolName === "bash").length, 1);
  await agent.close(); configured = false; calls = 0; agent = await createPiAgent(options); t.after(() => agent.close()); host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  assert.equal((await send()).result?.text, "没有配置执行工具");
  assert.equal((await log.read()).filter((e) => e.type === "capability_executed" && e.toolName === "bash").length, 1);
});

test("native Responses forwards read images in the active Run and recent history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "native-image-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const path = join(dir, "image.png"); await writeFile(path, Buffer.from(png, "base64")); let calls = 0;
  const server = createTestServer(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; const data = JSON.parse(raw);
    if (++calls === 1) response(res, { type: "function_call", id: "fc_read", call_id: "read_image", name: "read", arguments: JSON.stringify({ path }), status: "completed" });
    else {
      const image = data.input.find((item: any) => item.type === "function_call_output").output.find((part: any) => part.type === "input_image");
      assert.equal(image.image_url, `data:image/png;base64,${png}`);
      response(res, { type: "message", id: "msg_image", role: "assistant", content: [{ type: "output_text", text: "native done" }] });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, modelConfiguration: { defaultModel: "native", models: [{ alias: "native", api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}`, model: "native-test", apiKey: "test", toolSearch: "native" }] } });
  t.after(() => agent.close()); const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  for (const text of ["inspect image", "continue"]) assert.equal((await host.submit({ actor: { id: "owner" }, conversationId: "c", text }).done).type, "run_succeeded", JSON.stringify((await log.read()).filter((e) => ["tool_result", "request_failed"].includes(e.type))));
  assert.equal(calls, 3);
});

test("escape-heavy skill pages reach the Provider before being marked completely loaded", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "skill-escaped-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "source"); await mkdir(join(root, "escaped"), { recursive: true });
  const path = join(root, "escaped", "SKILL.md"); const tail = '"'.repeat(6000);
  await writeFile(path, "---\nname: escaped\ndescription: Escaped instructions\n---\n" + tail);
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent"); let calls = 0;
  const server = createTestServer(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; const data = JSON.parse(raw);
    if (++calls === 1) completion(res, "read", { path });
    else if (calls === 2) completion(res, "read", { path, offset: 5 });
    else { assert.ok(data.messages.at(-1).content.includes(tail)); completion(res); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, skillSources: [{ name: "source", path: root }] });
  t.after(() => agent.close()); const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  assert.equal((await host.submit({ actor: { id: "owner" }, conversationId: "c", text: "read skill" }).done).type, "run_succeeded");
  assert.equal((await log.read()).findLast((e) => e.type === "skill_read")?.complete, true);
});
