import { closeFixture } from "./fixtures/cleanup.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTelegramHostFixture } from "./fixtures/telegram-host.js";
import { access, rm } from "node:fs/promises";
import { createTestServer } from "./fixtures/http-server.js";

test("Telegram entry uses real pi to select MCP search and resumes from the event log", async (t) => {
  let query = "";
  const offeredTools = new Set<string>();
  const prompts: Array<Array<{ role: string; content?: string }>> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const data = JSON.parse(body);
    if (req.url === "/mcp") {
      let result: unknown;
      if (data.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } };
      else if (data.method === "tools/list") result = { tools: [
        { name: "search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
        { name: "fetch_content", inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" } } }, required: ["urls"] } },
      ] };
      else if (data.method === "tools/call") {
        query = data.params.arguments.query;
        result = { content: [{ type: "text", text: "Found source: https://example.com/news" }] };
      } else { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: data.id, result }));
      return;
    }
    for (const tool of data.tools ?? []) offeredTools.add(tool.function.name);
    prompts.push(data.messages);
    const last = data.messages.at(-1);
    const needsTool = last.role === "user" && JSON.stringify(last.content).includes("搜索");
    const delta = needsTool
      ? { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"news"}' } }] }
      : { content: last.role === "tool" ? `查询结果：${last.content}` : "普通聊天回复" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta, finish_reason: needsTool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const dir = await mkdtemp(join(tmpdir(), "pi-integration-"));
  const options = { dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test", tinyfishKey: "test", modelBaseUrl: url, tinyfishUrl: `${url}/mcp` };

  let shutdown = async () => {};
  t.after(() => closeFixture({ server, dir, shutdown: () => shutdown() }));
  const app = await createTelegramHostFixture(t, { agentOptions: options });

  shutdown = () => app.close();
  await app.send("搜索新闻", { messageId: 1 });
  assert.equal(query, "news");
  assert.match(app.sent.at(-1) ?? "", /https:\/\/example.com\/news/);
  assert.deepEqual([...offeredTools].sort(), ["edit", "read", "tool_call", "tool_search", "web_search", "write"]);
  await app.restart();
  await app.send("接着聊天", { messageId: 2 });
  assert.ok(prompts.at(-1)?.some((message) => message.content === "搜索新闻"));
  assert.equal(app.sent.at(-1), "普通聊天回复");
  await app.send("/reset", { messageId: 3 });
  await app.send("新对话", { messageId: 4 });
  assert.equal(prompts.at(-1)?.filter((message) => message.content === "新对话").length, 1);
  assert.ok(!prompts.at(-1)?.some((message) => message.content === "搜索新闻" || message.content === "接着聊天"));
  assert.equal((await app.rootLog.read()).filter((event) => event.type === "tool_dispatch").length, 1);
});

test("current Telegram tool path protection blocks dispatch and preserves runtime storage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tool-boundary-"));

  const seen: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    seen.push(JSON.parse(body));
    const delta = seen.length === 1 ? { tool_calls: [{ index: 0, id: "guarded", type: "function", function: {
      name: "write", arguments: JSON.stringify({ path: "@events.jsonl", content: "must not write" }),
    } }] } : { content: "已确认受保护路径。" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address(); assert.ok(address && typeof address !== "string");
  let shutdown = async () => {};
  t.after(() => closeFixture({ server, dir, shutdown: () => shutdown() }));
  const app = await createTelegramHostFixture(t, { agentOptions: { dataDir: dir,
    promptFile: "system-prompt.md", deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}` } });

  shutdown = () => app.close();
  await app.send("验证路径保护");
  const events = await app.rootLog.read();
  assert.equal(seen.length, 2);
  assert.match(JSON.stringify(seen[1]), /受保护/);
  assert.ok(events.some((event) => event.type === "tool_blocked" && event.toolCallId === "guarded"));
  assert.ok(!events.some((event) => event.type === "tool_dispatch"));
  await assert.rejects(access(join(dir, "events.jsonl")), { code: "ENOENT" });
  assert.equal(app.sent.at(-1), "已确认受保护路径。");
});

for (const commentary of [false, true]) test(`current blocked tool loop ${commentary ? "with commentary" : "without text"} stops after three attempts`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blocked-tool-loop-"));
  let calls = 0;
  const server = createTestServer(t, async (req, res) => {
    for await (const _part of req) { /* Drain the actual Provider request. */ }
    calls++;
    const delta = { ...(commentary ? { content: "正在核查路径保护。" } : {}),
      tool_calls: [{ index: 0, id: `blocked-${calls}`, type: "function", function: {
        name: "write", arguments: JSON.stringify({ path: "@events.jsonl", content: "must not write" }),
      } }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let shutdown = async () => {};
  t.after(() => closeFixture({ server, dir, shutdown: () => shutdown() }));
  const f = await createTelegramHostFixture(t, { agentOptions: { dataDir: dir, promptFile: "system-prompt.md",
    deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}` } });
  shutdown = () => f.close();
  await f.send("检查受保护路径");
  const facts = await f.rootLog.read();
  assert.equal(calls, 3);
  assert.equal(facts.filter((event) => event.type === "tool_blocked").length, 3);
  assert.ok(!facts.some((event) => event.type === "tool_dispatch" || event.type === "run_succeeded" || event.type === "delivery_succeeded"));
  assert.match(String(facts.find((event) => event.type === "run_failed")?.error), /连续三次未推进/);
  await assert.rejects(access(join(dir, "events.jsonl")), { code: "ENOENT" });
  if (commentary) assert.ok(f.sent.some((text) => text.includes("正在核查路径保护")));
});
