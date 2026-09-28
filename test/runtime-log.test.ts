import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createPiAgent } from "../src/pi-agent.js";
import { createRuntimeLog } from "../src/runtime-log.js";

test("large tool result is durably archived, pruned, and readable with the existing read tool", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-runtime-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "source.txt");
  const original = Array.from({ length: 250 }, (_, i) => `line ${i}: ${"details ".repeat(8)}`).join("\n");
  await writeFile(source, original);
  const prompts: Array<Array<{ role: string; content?: string }>> = [];
  let phase = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    prompts.push(data.messages);
    let delta: object;
    let finish_reason = "tool_calls";
    if (phase === 0) {
      delta = { tool_calls: [{ index: 0, id: "read_source", type: "function", function: {
        name: "read", arguments: JSON.stringify({ path: source }),
      } }] };
    } else if (phase === 1) {
      const toolText = String(data.messages.at(-1)?.content);
      const archivePath = toolText.match(/路径：(.+?\.txt)/)?.[1];
      assert.ok(archivePath, toolText);
      delta = { tool_calls: [{ index: 0, id: "read_archive", type: "function", function: {
        name: "read", arguments: JSON.stringify({ path: archivePath, offset: 1, limit: 5 }),
      } }] };
    } else {
      delta = { content: "已核对归档内容" };
      finish_reason = "stop";
    }
    phase++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => agent.close());
  const replies: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, answer: agent.answer,
    send: async (text) => { replies.push(text); } });
  await app.handle({ userId: 42, chatType: "private", text: "检查文件", messageId: 1 });
  assert.equal(replies.at(-1), "已核对归档内容");
  assert.equal(prompts.length, 3);
  assert.doesNotMatch(String(prompts[1]?.at(-1)?.content), /line 200:/);
  assert.match(String(prompts[1]?.at(-1)?.content), /工具结果已归档/);
  assert.match(String(prompts[2]?.at(-1)?.content), /line 0:/);
  const events = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const results = events.filter((event) => event.type === "tool_result");
  assert.equal(results.length, 2);
  assert.equal(events.filter((event) => event.type === "model_step_started").length, 3);
  assert.equal(events.filter((event) => event.type === "model_message").length, 3);
  assert.equal(results[0].requestId, results[1].requestId);
  assert.equal(results[0].toolCallId, "read_source");
  assert.match(JSON.stringify(results[0].result), /line 200:/);
  assert.equal(results[0].result.isError, false);
  const raw = await readFile(results[0].archive.rawPath, "utf8");
  assert.match(raw, /line 200:/);
  const fragments = (await readFile(results[0].archive.path, "utf8")).split("\n").map((line) => JSON.parse(line));
  assert.equal(fragments.map((part) => part.text).join(""), raw);
  assert.equal(createHash("sha256").update(raw).digest("hex"), results[0].archive.rawSha256);
  assert.equal(createHash("sha256").update(await readFile(results[0].archive.path)).digest("hex"),
    results[0].archive.sha256);
});

for (const fault of ["archive", "tool_call", "tool_dispatch", "tool_result"] as const) {
  test(`runtime handles ${fault} persistence failure at the Telegram entry`, { timeout: 60_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), `pi-${fault}-`));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = join(dir, "source.txt");
    const target = join(dir, "written.txt");
    await writeFile(source, "original-result-".repeat(800));
    let calls = 0;
    let nextContext = "";
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      calls++;
      let delta: object;
      let finish_reason = "tool_calls";
      if (calls === 1) {
        delta = { tool_calls: [{ index: 0, id: "one_call", type: "function", function: {
          name: fault === "archive" ? "read" : "write",
          arguments: JSON.stringify(fault === "archive" ? { path: source } : { path: target, content: "written" }),
        } }] };
      } else {
        nextContext = String(data.messages.at(-1)?.content);
        delta = { content: "finished" };
        finish_reason = "stop";
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agent = await createPiAgent({ dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
      modelBaseUrl: `http://127.0.0.1:${address.port}` });
    t.after(() => agent.close());
    const replies: string[] = [];
    const app = createApp({ ownerId: 42, dataDir: dir,
      answer: (messages, request) => agent.answer(messages, { ...request, log: {
        ...request.log,
        archive: fault === "archive" ? async () => { throw new Error("archive unavailable"); } : request.log.archive,
        append: async (event) => {
          if (event.type === fault) throw new Error("event log unavailable");
          await request.log.append(event);
        },
      } }),
      send: async (text) => { replies.push(text); },
    });
    await app.handle({ userId: 42, chatType: "private", text: "do work", messageId: 1 });
    const events = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    if (fault === "archive") {
      assert.equal(calls, 2);
      assert.match(nextContext, /original-result-/);
      assert.ok(events.some((event) => event.type === "tool_result" && event.archiveError && event.result));
      assert.equal(replies.at(-1), "finished");
    } else {
      assert.equal(calls, 1, "the model must not continue after a core log failure");
      assert.match(replies.at(-1) ?? "", /暂时处理失败/);
      if (fault === "tool_call" || fault === "tool_dispatch") {
        await assert.rejects(access(target), { code: "ENOENT" });
        assert.equal(events.some((event) => event.type === "tool_call"), fault === "tool_dispatch");
      } else {
        assert.equal(await readFile(target, "utf8"), "written");
        assert.ok(events.some((event) => event.type === "tool_call"));
        assert.ok(!events.some((event) => event.type === "tool_result"));
      }
    }
  });
}

test("archived long Unicode line is readable through bounded continuations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-archive-page-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  const result = { content: [{ type: "text" as const, text: "龙🐉".repeat(4000) }], details: {}, isError: false };
  const archive = await log.archive(result);
  await log.append({ type: "tool_result", requestId: "one", toolCallId: "large", toolName: "read",
    result, archive, modelVisible: "archive" });
  await rm(archive.path);
  let next = { path: archive.path, offset: 1, limit: 1 };
  let collected = "";
  let pages = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    const tool = data.messages.at(-1);
    if (tool.role === "tool") {
      const content = String(tool.content);
      assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: content }], details: {} })) <= 7500);
      const continuation = content.match(/\n\[继续读取：read\((\{.*\})\)\]$/);
      collected += continuation ? content.slice(0, continuation.index) : content;
      if (continuation) next = JSON.parse(continuation[1]!);
      else next = { path: "", offset: 0, limit: 0 };
      pages++;
    }
    const call = next.path && pages < 100;
    const delta = call ? { tool_calls: [{ index: 0, id: `page-${pages}`, type: "function",
      function: { name: "read", arguments: JSON.stringify(next) } }] } : { content: "complete" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta,
      finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => agent.close());
  const app = createApp({ ownerId: 42, dataDir: dir, answer: agent.answer, send: async () => {} });
  await app.handle({ userId: 42, chatType: "private", text: "read archive", messageId: 1 });
  assert.ok(pages > 1 && pages < 100);
  assert.equal(createHash("sha256").update(collected).digest("hex"),
    createHash("sha256").update(await readFile(archive.path, "utf8")).digest("hex"));
});
