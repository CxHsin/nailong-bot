import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createApp } from "../src/application/app.js";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { discoveredToolPlan } from "./fixtures/discovered-tools.js";

for (const tinyfishUnavailable of [false, true]) {
  test(`owner can use local files through real pi when TinyFish is ${tinyfishUnavailable ? "unavailable" : "not configured"}`, { timeout: 60_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-local-files-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dataDir = join(dir, "data");
    const note = join(dataDir, "笔记", "idea.md");
    const actions = [
      { text: "将上述结论保存到本地", name: "write",
        args: { path: "笔记/idea.md", content: "# Idea\n把有趣的结论保留下来。\n" }, expected: /Successfully wrote/ },
      { text: "补充这个结论", name: "edit",
        args: { path: note, oldText: "把有趣的结论保留下来。", newText: "把有趣的结论保留下来，供后续思考。" }, expected: /Successfully replaced/ },
      { text: "读取这个文件", name: "read", args: { path: note }, expected: /供后续思考/ },
      { text: "查看笔记目录", name: "ls", args: { path: "笔记" }, expected: /idea\.md/ },
      { text: "查找 Markdown 文件", name: "find", args: { path: "笔记", pattern: "*.md" }, expected: /idea\.md/ },
      { text: "搜索笔记里的结论", name: "grep", args: { path: "笔记", pattern: "后续思考" }, expected: /idea\.md:2:.*后续思考/ },
      { text: "读取不存在的文件", name: "read", args: { path: "missing.md" }, expected: /ENOENT/ },
    ];
    const offeredTools = new Set<string>();
    const plan = discoveredToolPlan();
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/mcp") { res.writeHead(503).end("MCP unavailable"); return; }
      const data = JSON.parse(body);
      if (plan.continue(data, res)) return;
      for (const tool of data.tools ?? []) offeredTools.add(tool.function.name);
      const last = data.messages.at(-1);
      const action = actions.find(({ text }) => last.role === "user" && JSON.stringify(last.content).includes(text));
      const selected = action ? plan.select(action.name, action.args) : undefined;
      const delta = action
        ? { tool_calls: [{ index: 0, id: "save_1", type: "function", function: {
          name: selected!.name, arguments: JSON.stringify(selected!.args),
        } }] }
        : { content: JSON.stringify({ type: "final", text: `文件操作结果：${last.content}` }) };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta, finish_reason: action ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agent = await createPiAgent({ outputProtocol: "json-text-v2",
      dataDir, promptFile: "system-prompt.md", deepseekKey: "test",
      modelBaseUrl: `http://127.0.0.1:${address.port}`,
      ...(tinyfishUnavailable ? { tinyfishKey: "test", tinyfishUrl: `http://127.0.0.1:${address.port}/mcp` } : {}),
    });
    t.after(() => agent.close());
    const replies: string[] = [];
    const app = createApp({ ownerId: 42, dataDir, answer: agent.answer,
      send: async (text) => { replies.push(text); },
    });
    await app.handle({ userId: 42, chatType: "private", text: "将上述结论保存到本地", messageId: 1 });
    assert.equal(await readFile(note, "utf8"), "# Idea\n把有趣的结论保留下来。\n");
    assert.match(replies.at(-1) ?? "", /Successfully wrote/);
    assert.deepEqual([...offeredTools].sort(), ["edit", "read", "tool_call", "tool_search", "web_search", "write"]);
    for (const [index, action] of actions.slice(1).entries()) {
      await app.handle({ userId: 42, chatType: "private", text: action.text, messageId: index + 2 });
      assert.match(replies.at(-1) ?? "", action.expected, action.name);
    }
    assert.equal(await readFile(note, "utf8"), "# Idea\n把有趣的结论保留下来，供后续思考。\n");
  });
}
