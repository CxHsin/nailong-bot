import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createPiAgent } from "../src/pi-agent.js";

test("Telegram entry uses real pi to select MCP search and resumes from the event log", async () => {
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
  const replies: string[] = [];
  let agent: Awaited<ReturnType<typeof createPiAgent>> | undefined;
  try {
    agent = await createPiAgent(options);
    let app = createApp({ ownerId: 42, dataDir: dir, answer: async (messages) => {
      try { return await agent!.answer(messages); } catch (error) { console.error(error); throw error; }
    }, send: async (text) => { replies.push(text); } });
    await app.handle({ userId: 42, chatType: "private", text: "搜索新闻", messageId: 1 });
    assert.equal(query, "news");
    assert.match(replies[0] ?? "", /https:\/\/example.com\/news/);
    assert.deepEqual([...offeredTools].sort(), ["edit", "find", "grep", "ls", "read", "web_fetch", "web_search", "write"]);
    await agent.close();
    agent = await createPiAgent(options);
    app = createApp({ ownerId: 42, dataDir: dir, answer: agent.answer, send: async (text) => { replies.push(text); } });
    await app.handle({ userId: 42, chatType: "private", text: "接着聊天", messageId: 2 });
    assert.ok(prompts.at(-1)?.some((message) => message.content === "搜索新闻"));
    assert.equal(replies.at(-1), "普通聊天回复");
    await app.handle({ userId: 42, chatType: "private", text: "/reset", messageId: 3 });
    await app.handle({ userId: 42, chatType: "private", text: "新对话", messageId: 4 });
    assert.equal(prompts.at(-1)?.filter((message) => message.role === "user").length, 1);
  } finally {
    await agent?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
