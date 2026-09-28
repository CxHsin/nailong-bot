import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "../src/app.js";
import { createPiAgent } from "../src/pi-agent.js";
import { assistantText } from "../src/projection.js";
import { getModel } from "@mariozechner/pi-ai";

type WireMessage = { role: string; content?: string; tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
type Payload = { messages: WireMessage[]; tools?: unknown[]; max_tokens?: number; max_completion_tokens?: number };
function reply(res: ServerResponse, content: string, call?: { id: string; name: string; args: object }) {
  const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: {
    name: call.name, arguments: JSON.stringify(call.args),
  } }] } : { content };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta,
    finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}
async function fixture(t: TestContext, respond: (data: Payload, res: ServerResponse) => void,
  options: Partial<Parameters<typeof createPiAgent>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "projection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.md");
  await writeFile(promptFile, "Be helpful.");
  const seen: Payload[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data: Payload = JSON.parse(body);
    seen.push(data);
    respond(data, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agentOptions = { dataDir: dir, promptFile, deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}`, ...options };
  let agent = await createPiAgent(agentOptions);
  t.after(() => agent.close());
  const replies: string[] = [];
  const makeApp = () => createApp({ ownerId: 42, dataDir: dir, answer: agent.answer,
    send: async (text) => { replies.push(text); } });
  let app = makeApp();
  return { dir, seen, replies,
    async send(text: string) { await app.handle({ userId: 42, chatType: "private", text, messageId: seen.length + 1 }); },
    async restart() { await agent.close(); agent = await createPiAgent(agentOptions); app = makeApp(); },
  };
}

test("restart replays tool exchanges, including errors, without duplicating calls", async (t) => {
  const f = await fixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "user" && last.content === "read missing") {
      reply(res, "", { id: "same-id", name: "read", args: { path: "missing.txt" } });
    } else reply(res, "finished");
  });
  await f.send("read missing");
  assert.equal(f.replies.at(-1), "finished", await readFile(join(f.dir, "events.jsonl"), "utf8"));
  await f.restart();
  await f.send("continue");
  const history = f.seen.at(-1)!.messages;
  assert.equal(history.flatMap((m) => m.tool_calls ?? []).length, 1);
  assert.equal(history.filter((m) => m.role === "tool").length, 1);
  assert.match(history.find((m) => m.role === "tool")!.content!, /ENOENT/);
  assert.equal(history.at(-1)!.content, "continue");
  await f.send("/reset");
  await f.send("new");
  assert.equal(f.seen.at(-1)!.messages.filter((m) => m.role === "user").length, 1);
  assert.equal(f.seen.at(-1)!.messages.some((m) => m.role === "tool"), false);
  assert.match(await readFile(join(f.dir, "events.jsonl"), "utf8"), /same-id/);
});

const summary = "## Goal\nContinue the task.\n## Progress\nEarlier work completed.\n## Constraints\nKeep the user's requirements.\n## Decisions\nPreserve evidence.\n## Next Steps\nContinue recent work.\n## Critical Context\nUse the original log for exact details.";

test("model window budget folds old history, preserves three requests, and reuses a validated checkpoint", async (t) => {
  let summaries = 0;
  const f = await fixture(t, (data, res) => {
    if (data.messages.some((m) => m.content?.includes("HISTORY_COMPACTION"))) {
      summaries++; reply(res, summary);
    } else reply(res, "finished");
  }, { contextWindow: 6000 });
  const events = Array.from({ length: 6 }, (_, i) => [
    { type: "message", role: "user", text: `old-${i}:` + "x".repeat(1500), at: `2026-01-01T00:00:0${i}Z` },
    { type: "message", role: "assistant", text: "answer:" + "y".repeat(1500), at: `2026-01-01T00:00:0${i}Z` },
  ]).flat();
  await writeFile(join(f.dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await f.send("continue");
  assert.equal(f.replies.at(-1), "finished");
  assert.ok(summaries > 0);
  const normal = f.seen.at(-1)!;
  const history = JSON.stringify(normal.messages);
  assert.match(history, /历史摘要/);
  assert.doesNotMatch(history, /old-0:/);
  assert.match(history, /old-3:/);
  assert.match(history, /old-5:/);
  const outputLimit = normal.max_tokens ?? normal.max_completion_tokens;
  assert.ok(outputLimit! <= 6000 && outputLimit! > 0);
  const before = summaries;
  await f.restart();
  await f.send("again");
  assert.equal(summaries, before);
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /历史摘要/);
  assert.match(await readFile(join(f.dir, "events.jsonl"), "utf8"), /old-0:/);
});

test("a stopped dispatched tool is projected as unknown without persisting a fabricated result", async (t) => {
  const f = await fixture(t, (_data, res) => reply(res, "checked"));
  const message = assistantText("checking", getModel("deepseek", "deepseek-v4-flash"));
  message.content.push({ type: "toolCall", id: "uncertain", name: "write", arguments: { path: "note", content: "text" } });
  const events = [
    { type: "message", role: "user", text: "save", requestId: "old" },
    { type: "model_message", requestId: "old", message },
    { type: "tool_dispatch", requestId: "old", toolCallId: "uncertain", toolName: "write" },
    { type: "request_failed", requestId: "old" },
  ].map((e) => ({ ...e, at: "2026-01-01T00:00:00Z" }));
  await writeFile(join(f.dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await f.send("check status");
  assert.match(f.seen.at(-1)!.messages.find((m) => m.role === "tool")!.content!, /outcome_unknown/);
  const stored = (await readFile(join(f.dir, "events.jsonl"), "utf8")).trim().split("\n").map((e) => JSON.parse(e));
  assert.equal(stored.some((e) => e.type === "tool_result"), false);
});

test("provider overflow compacts and retries the rejected model step once", async (t) => {
  let normal = 0;
  const f = await fixture(t, (data, res) => {
    if (data.messages.some((m) => m.content?.includes("HISTORY_COMPACTION"))) reply(res, summary);
    else if (++normal === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "maximum context length exceeded", type: "invalid_request_error" } }));
    } else reply(res, "recovered");
  });
  await writeFile(join(f.dir, "events.jsonl"), [
    { type: "message", role: "user", text: "old goal " + "a".repeat(1500) },
    { type: "message", role: "assistant", text: "old answer " + "b".repeat(1500) },
  ].map((e) => JSON.stringify({ ...e, at: "2026-01-01T00:00:00Z" })).join("\n") + "\n");
  await f.send("continue");
  assert.equal(f.replies.at(-1), "recovered");
  assert.equal(normal, 2);
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /历史摘要/);
});

test("a single long tool chain compacts settled earlier steps while keeping the current goal", async (t) => {
  let tools = 0;
  let compacted = false;
  const f = await fixture(t, (data, res) => {
    if (data.messages.some((m) => m.content?.includes("HISTORY_COMPACTION"))) {
      compacted = true; reply(res, summary);
    } else if (tools < 8) reply(res, "", { id: `read-${tools++}`, name: "read", args: { path: "source.txt" } });
    else reply(res, "chain finished");
  }, { contextWindow: 6000 });
  await writeFile(join(f.dir, "source.txt"), "evidence ".repeat(500));
  await f.send("inspect all evidence");
  assert.equal(f.replies.at(-1), "chain finished", await readFile(join(f.dir, "events.jsonl"), "utf8"));
  assert.equal(compacted, true);
  const final = f.seen.at(-1)!.messages;
  assert.equal(final.filter((m) => m.content === "inspect all evidence").length, 1);
  const ids = final.flatMap((m) => m.tool_calls ?? []).map((c) => c.id);
  assert.ok(final.filter((m) => m.role === "tool").every((m) => ids.includes(m.tool_call_id!)));
});

test("an input that cannot be split is rejected before provider dispatch at a per-model ratio", async (t) => {
  const f = await fixture(t, (_data, res) => reply(res, "should not dispatch"), {
    contextWindow: 6000, modelBudgetRatios: { "deepseek/deepseek-v4-flash": 0.4 },
  });
  await f.send("large current input " + "x".repeat(7000));
  assert.equal(f.seen.length, 0);
  assert.match(f.replies.at(-1)!, /处理失败/);
  assert.match(await readFile(join(f.dir, "events.jsonl"), "utf8"), /预算/);
});

test("archive references remain pruned on restart and corrupt archives stop replay", async (t) => {
  const f = await fixture(t, (data, res) => {
    if (data.messages.at(-1)?.content === "read large") {
      reply(res, "", { id: "large", name: "read", args: { path: "large.txt" } });
    } else reply(res, "finished");
  });
  await writeFile(join(f.dir, "large.txt"), "big-evidence ".repeat(2000));
  await f.send("read large");
  await f.restart();
  await f.send("continue");
  const tool = f.seen.at(-1)!.messages.find((m) => m.role === "tool")!;
  assert.match(tool.content!, /工具结果已归档/);
  assert.doesNotMatch(tool.content!, /big-evidence/);
  const events = (await readFile(join(f.dir, "events.jsonl"), "utf8")).trim().split("\n").map((s) => JSON.parse(s));
  const result = events.find((e) => e.type === "tool_result");
  assert.equal(result.modelVisible, "archive");
  await writeFile(result.archive.rawPath, "corrupted");
  const before = f.seen.length;
  await f.send("check again");
  assert.equal(f.seen.length, before);
  assert.match(f.replies.at(-1)!, /处理失败/);
});
