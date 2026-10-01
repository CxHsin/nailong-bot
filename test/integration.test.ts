import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createApp } from "../src/application/app.js";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";

test("structured progress continues within the same request", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    const delta = calls++ === 0 ? { content: JSON.stringify({ type: "progress", text: "我先查一下。" }) } :
      calls === 2 ? { tool_calls: [{ index: 0, id: "call_search", type: "function",
        function: { name: "ls", arguments: '{"path":"."}' } }] } :
        { content: JSON.stringify({ type: "final", text: "查询完成。" }) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta,
      finish_reason: calls === 2 ? "stop" : calls === 3 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const dir = await mkdtemp(join(tmpdir(), "pi-continuation-"));
  const agent = await createPiAgent({ dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  try {
    const log = createRuntimeLog(dir);
    await log.append({ type: "message", role: "user", text: "请搜索新闻", requestId: "r1" });
    const answer = await agent.answer([{ role: "user", text: "请搜索新闻" }], { id: "r1", log });
    assert.equal(answer, "查询完成。");
    assert.equal(calls, 3);
    const events = await log.read();
    assert.ok(events.some((event) => event.type === "tool_dispatch" && event.toolName === "ls"));
    assert.equal(events.filter((event) => event.type === "text_finalized" &&
      event.contentKind === "final").length, 1);
  } finally {
    await agent.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

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
      : { content: JSON.stringify({ type: "final", text: last.role === "tool" ? `查询结果：${last.content}` : "普通聊天回复" }) };
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


for (const scenario of ["conflict", "invalid", "idle", "alternating", "protected", "blocked-progress", "only-blocked", "progress-blocked"] as const) {
  test(`protocol ${scenario} preserves execution boundaries`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "protocol-boundary-"));
    const seen: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let count = 0;
    const tool = { index: 0, id: "guarded", type: "function", function: { name: "write",
      arguments: JSON.stringify({ path: (scenario === "protected" || scenario.includes("blocked")) ? "@events.jsonl" : "side-effect.txt", content: "must not write" }) } };
    const server = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      seen.push(JSON.parse(body));
      count++;
      let delta: Record<string, unknown>;
      if (scenario === "only-blocked" || scenario === "progress-blocked") delta = {
        ...(scenario === "progress-blocked" ? { content: JSON.stringify({ type: "progress", text: "继续检查。" }) } : {}),
        tool_calls: [{ ...tool, id: `blocked-${count}` }] };
      else if (scenario === "blocked-progress") delta = count % 3 === 0 ? { tool_calls: [{ ...tool, id: `blocked-${count}` }] } :
        { content: JSON.stringify({ type: "progress", text: "继续检查。" }) };
      else if (scenario === "idle") delta = { content: JSON.stringify({ type: "progress", text: "继续检查。" }) };
      else if (scenario === "alternating") delta = { content: count % 2 ? "invalid" : JSON.stringify({ type: "progress", text: "继续检查。" }) };
      else if (count === 1 && scenario === "conflict") delta = { content: JSON.stringify({ type: "final", text: "提前结束。" }), tool_calls: [tool] };
      else if (count === 1 && scenario === "protected") delta = { tool_calls: [tool] };
      else if (count === 1) delta = { content: "普通文字不能结束" };
      else delta = { content: JSON.stringify({ type: "final", text: "恢复完成。" }) };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const agent = await createPiAgent({ dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
      modelBaseUrl: `http://127.0.0.1:${address.port}` });
    t.after(() => agent.close());
    const log = createRuntimeLog(dir); const replies: string[] = [];
    const app = createApp({ ownerId: 42, dataDir: dir, log, answer: agent.answer,
      send: async (text) => { replies.push(text); } });
    await app.handle({ userId: 42, chatType: "private", text: "验证协议", messageId: 1 });
    const events = await log.read();
    if (scenario === "idle" || scenario === "alternating" || scenario.includes("blocked")) {
      assert.match(replies.at(-1) ?? "", /未完成/);
      assert.ok(!events.some((e) => e.type === "delivery_succeeded"));
      assert.ok(count <= 6);
    } else assert.equal(replies.at(-1), "恢复完成。");
    if (scenario === "conflict" || scenario === "protected") assert.ok(!events.some((e) => e.type === "tool_dispatch"));
    if (scenario === "conflict" || scenario === "invalid") {
      assert.ok(events.some((e) => e.type === "protocol_feedback" && e.source === "runtime"));
      assert.ok(!events.some((e) => e.type === "text_finalized" && e.text === "提前结束。"));
      assert.match(JSON.stringify(seen[1]), /运行层协议反馈/);
      await app.handle({ userId: 42, chatType: "private", text: "继续对话", messageId: 2 });
      assert.match(JSON.stringify(seen.at(-1)), /运行层协议反馈/);
      const finalHistory = seen.at(-1)!.messages.find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes("恢复完成"));
      assert.deepEqual(JSON.parse(finalHistory!.content as string), { type: "final", text: "恢复完成。" });
    }
    if (scenario === "protected") assert.match(JSON.stringify(seen[1]), /受保护/);
  });
}
