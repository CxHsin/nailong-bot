import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createApp } from "../src/application/app.js";
import { createBoundedRead } from "../src/agent/archive-read.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { webReadPath, webResultPreview, webResultBody } from "../src/runtime/web-result.js";
import { toolResultView, replayToolResultView } from "../src/context/tool-result-projection.js";
import type { ToolResult } from "../src/runtime/runtime-types.js";

const body = "# 文档\n" + "定义：chief-of-staff 是统筹助手🐉。\n".repeat(500) + "尾部证据";
const result: ToolResult = { content: [{ type: "text", text: JSON.stringify({ results: [
  { url: "https://example.com/changelog", title: "更新", text: body },
  { url: "https://example.com/skills", title: "目录", text: "Navigation ".repeat(240) + "\nengineering\nin-progress\nproductivity",
    links: ["https://other.example.com/login", "https://example.com/skills/in-progress/chief-of-staff"] },
], errors: [{ url: "https://example.com/search", error: "unauthorized", status: 401 }] }) }], details: {}, isError: false };
const archive = { path: "result.txt", bytes: 10000, sha256: "a", rawPath: "result.json", rawBytes: 10000, rawSha256: "b" };

test("large web batch preserves short directory, provenance, errors and bounded previews", () => {
  const active = toolResultView("web_fetch", result, archive, false);
  assert.equal(active.modelVisible, "archive");
  const text = active.content.map((part) => part.type === "text" ? part.text : "").join("");
  assert.match(text, /engineering\nin-progress\nproductivity\n\[正文完整\]/);
  assert.match(text, /unauthorized（HTTP 401）/);
  assert.match(text, /#web=1/);
  assert.match(text, /https:\/\/example.com\/skills\/in-progress\/chief-of-staff/);
  assert.ok(text.indexOf("页面链接") < text.indexOf("https://other.example.com/login"));
  assert.doesNotMatch(text, /\\n|\\"/);
  assert.ok(Buffer.byteLength(JSON.stringify(active.content)) <= 7000);
  assert.deepEqual(replayToolResultView({ result, archive, recorded: "archive", projectionVersion: 2,
    archiveRead: false, olderThanRecent: true, toolName: "web_fetch" }).content, active.content);
  const legacy = replayToolResultView({ result, archive, recorded: "archive", projectionVersion: 1,
    archiveRead: false, olderThanRecent: true, toolName: "web_fetch" }).content;
  assert.match(JSON.stringify(legacy), /JSONL/);
  assert.doesNotMatch(JSON.stringify(legacy), /in-progress/, "the legacy presentation hides the directory clue that the new view must preserve");
});

test("web preview budget holds for ten Unicode pages and malformed envelopes fall back", () => {
  const batch: ToolResult = { ...result, content: [{ type: "text", text: JSON.stringify({ results:
    Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}`, title: "龙".repeat(100), text: "🐉".repeat(900) })) }) }] };
  const content = webResultPreview(batch, archive)!;
  assert.ok(content);
  assert.ok(Buffer.byteLength(JSON.stringify(content)) <= 7000);
  assert.equal(webResultPreview({ ...result, content: [{ type: "text", text: '{"results":[null]}' }] }, archive), undefined);
  assert.match(JSON.stringify(toolResultView("grep", result, archive, false).content), /JSONL/);
});

test("web archive read returns complete decoded Unicode body through bounded continuations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "web-body-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  const stored = await log.archive(result);
  await log.append({ type: "tool_result", requestId: "one", toolCallId: "web", toolName: "web_fetch", result, archive: stored });
  const read = createBoundedRead(dir, log);
  const direct = await Reflect.apply(read.execute, read, ["direct", { path: stored.path, limit: 1 }]);
  assert.match(direct.content[0].text, /页面 1：更新/);
  assert.doesNotMatch(direct.content[0].text, /"part"/);
  let args = { path: webReadPath(stored, 1), offset: 1, limit: 3 };
  let collected = "";
  let pages = 0;
  while (pages++ < 200) {
    const response = await Reflect.apply(read.execute, read, ["read", args]);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 7500);
    const text = response.content[0].text;
    assert.doesNotMatch(text, /"part"|\\n|\\"/);
    const continuation = text.match(/\n\[继续读取：read\((\{.*\})\)\]$/);
    collected += continuation ? text.slice(0, continuation.index) : text;
    if (!continuation) break;
    args = JSON.parse(continuation[1]!);
  }
  assert.ok(pages > 1 && pages < 200);
  assert.equal(collected, body);
  let allArgs = { path: stored.path, offset: 1, limit: 120 };
  let allText = "";
  for (let i = 0; i < 100; i++) {
    const response = await Reflect.apply(read.execute, read, ["all", allArgs]);
    const text = response.content[0].text;
    const next = text.match(/\n\[继续读取：read\((\{.*\})\)\]$/);
    allText += next ? text.slice(0, next.index) : text;
    if (!next) break;
    allArgs = JSON.parse(next[1]!);
  }
  assert.equal(allText, webResultBody(result));
  await assert.rejects(Reflect.apply(read.execute, read, ["bad", { path: webReadPath(stored, 99) }]), /失效/);
  await assert.rejects(Reflect.apply(read.execute, read, ["bad", { path: webReadPath({ ...stored, sha256: "0".repeat(64) }, 1) }]), /失效/);
});

test("single long web line can be read without cutting Unicode code points", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "web-line-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  const text = "龙🐉".repeat(3000) + "\n\n尾部\n";
  const value: ToolResult = { ...result, content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://example.com", text }] }) }] };
  const stored = await log.archive(value);
  await log.append({ type: "tool_result", toolName: "web_fetch", result: value, archive: stored });
  const read = createBoundedRead(dir, log);
  let args = { path: webReadPath(stored, 1), offset: 1, limit: 1 };
  let collected = "";
  for (let i = 0; i < 100; i++) {
    const response = await Reflect.apply(read.execute, read, ["read", args]);
    const output = response.content[0].text;
    const next = output.match(/\n\[继续读取：read\((\{.*\})\)\]$/);
    collected += next ? output.slice(0, next.index) : output;
    if (!next) break;
    args = JSON.parse(next[1]!);
  }
  assert.equal(collected, text);
});

test("production Pi forwards page previews, reads decoded body and replays the same view", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "web-pi-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({ tools: ["search", "fetch_content"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) }));
  t.mock.method(Client.prototype, "callTool", async () => ({ content: result.content }));
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    calls++;
    let delta;
    if (calls === 1) delta = { tool_calls: [{ index: 0, id: "web", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ urls: ["https://example.com"] }) } }] };
    else if (calls === 2) {
      const text = String(data.messages.at(-1).content);
      assert.match(text, /engineering\nin-progress\nproductivity/);
      const next = JSON.parse(text.match(/read\((\{.*?\})\)/)![1]!);
      delta = { tool_calls: [{ index: 0, id: "body", type: "function", function: { name: "read", arguments: JSON.stringify(next) } }] };
    } else {
      if (calls === 3) {
        assert.match(String(data.messages.at(-1).content), /# 文档\n定义：chief-of-staff/);
        assert.doesNotMatch(String(data.messages.at(-1).content), /"part"/);
      } else assert.ok(data.messages.some((message: { role: string; content: string }) => message.role === "tool" && /engineering\nin-progress\nproductivity/.test(message.content)));
      delta = { content: JSON.stringify({ type: "final", text: "已核查" }) };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test", tinyfishKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}`, outputProtocol: "json-text-v2", memoryBootstrap: false });
  t.after(() => agent.close());
  const replies: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, answer: agent.answer, send: async (text) => { replies.push(text); } });
  await app.handle({ userId: 42, chatType: "private", messageId: 1, text: "查定义" });
  await app.handle({ userId: 42, chatType: "private", messageId: 2, text: "继续" });
  assert.equal(calls, 4);
  assert.deepEqual(replies, ["已核查", "已核查"]);
});
