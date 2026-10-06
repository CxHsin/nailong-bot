import { createTestServer } from "./fixtures/http-server.js";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "../src/application/app.js";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { assistantText } from "../src/agent/model-message.js";
import { getModel } from "@mariozechner/pi-ai";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { closeFixture } from "./fixtures/cleanup.js";
import { replayEvents } from "../src/context/projection.js";
import { createCheckpointStore } from "../src/context/checkpoint.js";
import { sourceDigest } from "../src/runtime/event-digest.js";

type WireMessage = { role: string; content?: string; tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
type Payload = { messages: WireMessage[]; tools?: unknown[]; max_tokens?: number; max_completion_tokens?: number };
function reply(res: ServerResponse, content: string, call?: { id: string; name: string; args: object }) {
  const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: {
    name: call.name, arguments: JSON.stringify(call.args),
  } }] } : { content: content.startsWith("## Goal") ? content : JSON.stringify({ type: "final", text: content }) };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta,
    finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}
async function fixture(t: TestContext, respond: (data: Payload, res: ServerResponse) => void,
  options: Partial<Parameters<typeof createPiAgent>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "projection-"));
  const promptFile = join(dir, "prompt.md");
  await writeFile(promptFile, "Be helpful.");
  const seen: Payload[] = [];
  const server = createTestServer(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data: Payload = JSON.parse(body);
    seen.push(data);
    respond(data, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agentOptions = { outputProtocol: "json-text-v2" as const, dataDir: dir, promptFile, deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}`, ...options };
  let agent = await createPiAgent(agentOptions);
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const replies: string[] = [];
  const makeApp = () => createApp({ ownerId: 42, dataDir: dir, answer: agent.answer,
    send: async (text) => { replies.push(text); } });
  let app = makeApp();
  let messageId = 0;
  return { dir, seen, replies,
    async send(text: string) { await app.handle({ userId: 42, chatType: "private", text, messageId: ++messageId }); },
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

test("protocol feedback corrects only its current Run and is excluded from compaction input", async (t) => {
  const f = await fixture(t, (_data, res) => reply(res, "finished"));
  const log = createRuntimeLog(f.dir);
  await log.append({ type: "message", role: "user", requestId: "old", text: "old user" });
  await log.append({ type: "protocol_feedback", requestId: "old", text: "STALE_PROTOCOL_FEEDBACK" });
  await log.append({ type: "request_failed", requestId: "old" });
  await log.append({ type: "message", role: "user", requestId: "current", text: "current user" });
  await log.append({ type: "protocol_feedback", requestId: "current", text: "CURRENT_PROTOCOL_FEEDBACK" });
  const replay = await replayEvents(log, "current", getModel("deepseek", "deepseek-v4-flash"), true);
  assert.doesNotMatch(JSON.stringify(replay.units.flatMap((unit) => unit.messages)), /STALE_PROTOCOL_FEEDBACK/);
  assert.match(JSON.stringify(replay.units.flatMap((unit) => unit.messages)), /CURRENT_PROTOCOL_FEEDBACK/);
  assert.doesNotMatch(JSON.stringify(replay.units.flatMap((unit) => unit.summaryMessages ?? unit.messages)), /PROTOCOL_FEEDBACK/);
  assert.notEqual(replay.boundary, "initial", "old-policy derived summaries must not be reused");
  const events = await log.read();
  await createCheckpointStore(f.dir, "structured-text-v1").save({ boundary: "initial", through: events.length,
    sourceDigest: sourceDigest(events), lastEventDigest: sourceDigest(events.at(-1)), summaryStrategy: "structured-text-v1",
    summary: "STALE_DERIVED_PROTOCOL_FEEDBACK", model: "deepseek/deepseek-flash", ratio: 0.82 });
  await f.send("next user");
  assert.doesNotMatch(JSON.stringify(f.seen.at(-1)!.messages), /PROTOCOL_FEEDBACK/);
  assert.equal((await log.read()).filter((event) => event.type === "protocol_feedback").length, 2);
});

test("real Provider correction survives its retry but not the next Run after restart", async (t) => {
  let calls = 0;
  const f = await fixture(t, (_data, res) => {
    if (++calls === 1) {
      const raw = '{"type":"final","text":"被拒绝正文","extra":true}';
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: raw }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    } else reply(res, "finished");
  });
  await f.send("first user");
  assert.equal(f.seen.length, 2);
  assert.match(JSON.stringify(f.seen[1]!.messages.filter((message) => message.role === "user")), /运行层协议反馈/);
  await f.restart();
  await f.send("next user");
  assert.doesNotMatch(JSON.stringify(f.seen[2]!.messages.filter((message) => message.role === "user")), /运行层协议反馈|被拒绝正文/);
  assert.equal(f.replies.at(-1), "finished");
});

const summary = "## Goal\nContinue the task.\n## Progress\nEarlier work completed.\n## Constraints\nKeep the user's requirements.\n## Decisions\nPreserve evidence.\n## Next Steps\nContinue recent work.\n## Critical Context\nUse the original log for exact details.";

test("recent turns retain complete tool pairs and settled text across restart while old archives are not recovered", async (t) => {
  const f = await fixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "user" && last.content?.startsWith("round-")) {
      reply(res, "", { id: last.content, name: "read", args: { path: `${last.content}.txt` } });
    } else reply(res, "complete answer");
  });
  for (let index = 0; index < 5; index++) await f.send(`round-${index}`);
  await f.restart();
  await f.send("continue recent turns");
  const messages = f.seen.at(-1)!.messages;
  const text = JSON.stringify(messages);
  assert.doesNotMatch(text, /round-0|round-1|历史摘要/);
  for (const id of ["round-2", "round-3", "round-4"]) {
    assert.equal(messages.flatMap((message) => message.tool_calls ?? []).filter((call) => call.id === id).length, 1);
    assert.equal(messages.filter((message) => message.role === "tool" && message.tool_call_id === id).length, 1);
  }
  assert.equal(messages.filter((message) => message.role === "assistant" && message.content?.includes("complete answer")).length, 3);
  const log = createRuntimeLog(f.dir);
  const model = getModel("deepseek", "deepseek-v4-flash");
  const currentId = (await log.read()).findLast((event) => event.type === "message" && event.role === "user")!.requestId!;
  const older = new Set((await log.read()).filter((event) => event.type === "tool_result" && ["round-0", "round-1"].includes(String(event.toolCallId)))
    .map((event) => sourceDigest(event.archive)));
  await replayEvents({ ...log, recoverArchive: async (archive, source) => {
    assert.ok(!older.has(sourceDigest(archive)), "outside-window archives must not be read");
    return log.recoverArchive(archive, source);
  } }, currentId, model);
});

test("restart restores only three complete recent turns without summarizing older history", async (t) => {
  let summaries = 0;
  const f = await fixture(t, (data, res) => {
    if (data.messages.some((m) => m.content?.includes("HISTORY_COMPACTION"))) {
      summaries++; reply(res, summary);
    } else reply(res, "finished");
  }, { contextWindow: 7600 });
  const events = Array.from({ length: 6 }, (_, i) => [
    { type: "message", role: "user", text: `old-${i}:` + "x".repeat(1500), at: `2026-01-01T00:00:0${i}Z` },
    { type: "message", role: "assistant", text: "answer:" + "y".repeat(1500), at: `2026-01-01T00:00:0${i}Z` },
  ]).flat();
  await writeFile(join(f.dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await f.send("continue");
  assert.equal(f.replies.at(-1), "finished");
  assert.equal(summaries, 0);
  const normal = f.seen.at(-1)!;
  const history = JSON.stringify(normal.messages);
  assert.doesNotMatch(history, /历史摘要/);
  assert.doesNotMatch(history, /old-0:/);
  assert.match(history, /old-3:/);
  assert.match(history, /old-5:/);
  const outputLimit = normal.max_tokens ?? normal.max_completion_tokens;
  assert.ok(outputLimit! <= 7600 && outputLimit! > 0);
  const before = summaries;
  await f.restart();
  await f.send("again");
  assert.equal(summaries, before);
  const restarted = JSON.stringify(f.seen.at(-1)!.messages);
  assert.doesNotMatch(restarted, /历史摘要|old-3:/);
  assert.match(restarted, /old-4:/);
  assert.match(restarted, /old-5:/);
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

test("a second provider overflow fails after one retry", async (t) => {
  let normal = 0;
  const f = await fixture(t, (data, res) => {
    if (data.messages.some((m) => m.content?.includes("HISTORY_COMPACTION"))) reply(res, summary);
    else {
      normal++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "maximum context length exceeded", type: "invalid_request_error" } }));
    }
  });
  await writeFile(join(f.dir, "events.jsonl"), [
    { type: "message", role: "user", text: "old goal " + "a".repeat(1500) },
    { type: "message", role: "assistant", text: "old answer " + "b".repeat(1500) },
  ].map((e) => JSON.stringify({ ...e, at: "2026-01-01T00:00:00Z" })).join("\n") + "\n");
  await f.send("continue");
  assert.equal(normal, 2);
  assert.match(f.replies.at(-1)!, /溢出重试失败/);
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
    contextWindow: 6000, modelBudgetRatios: { "deepseek/deepseek-flash": 0.4 },
  });
  await f.send("large current input " + "x".repeat(7000));
  assert.equal(f.seen.length, 0);
  assert.match(f.replies.at(-1)!, /处理失败/);
  assert.match(f.replies.at(-1)!, /预算/);
  assert.match(await readFile(join(f.dir, "events.jsonl"), "utf8"), /预算/);
});

test("recent archived results restore complete content on restart and corrupt copies recover from events", async (t) => {
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
  assert.doesNotMatch(tool.content!, /工具结果已归档/);
  assert.match(tool.content!, /big-evidence/);
  const events = (await readFile(join(f.dir, "events.jsonl"), "utf8")).trim().split("\n").map((s) => JSON.parse(s));
  const result = events.find((e) => e.type === "tool_result");
  assert.equal(result.modelVisible, "archive");
  await writeFile(result.archive.rawPath, "corrupted");
  await f.send("check again");
  assert.equal(f.replies.at(-1), "finished");
  assert.match(await readFile(result.archive.rawPath, "utf8"), /big-evidence/);
  await rm(join(f.dir, "tool-results"), { recursive: true, force: true });
  await f.send("recover missing archive directory");
  assert.equal(f.replies.at(-1), "finished");
  assert.match(await readFile(result.archive.rawPath, "utf8"), /big-evidence/);
});

test("a result before matching dispatch is not replayed as an executed tool", async (t) => {
  const f = await fixture(t, (_data, res) => reply(res, "checked"));
  const message = assistantText("", getModel("deepseek", "deepseek-v4-flash"));
  message.content.push({ type: "toolCall", id: "orphan", name: "write", arguments: { path: "note" } });
  const old = [
    { type: "message", role: "user", text: "save", requestId: "old" },
    { type: "model_message", requestId: "old", message },
    { type: "tool_result", requestId: "old", toolCallId: "orphan", toolName: "write",
      result: { content: [{ type: "text", text: "success" }], details: {}, isError: false } },
    { type: "tool_dispatch", requestId: "old", toolCallId: "orphan", toolName: "write" },
    { type: "request_failed", requestId: "old" },
  ];
  await writeFile(join(f.dir, "events.jsonl"), old.map((e) => JSON.stringify({ ...e,
    at: "2026-01-01T00:00:00Z" })).join("\n") + "\n");
  await f.send("check");
  assert.equal(f.seen.at(-1)!.messages.some((m) => m.role === "tool"), false);
  assert.equal(f.seen.at(-1)!.messages.some((m) => m.tool_calls?.some((c) => c.id === "orphan")), false);
});

test("a crashed dispatched tool is marked interrupted before its outcome becomes unknown", async (t) => {
  const f = await fixture(t, (_data, res) => reply(res, "checked"));
  const message = assistantText("", getModel("deepseek", "deepseek-v4-flash"));
  message.content.push({ type: "toolCall", id: "pending", name: "write", arguments: { path: "note" } });
  const old = [
    { type: "message", role: "user", text: "save", requestId: "old" },
    { type: "request_started", requestId: "old" },
    { type: "model_message", requestId: "old", message },
    { type: "tool_dispatch", requestId: "old", toolCallId: "pending", toolName: "write" },
  ];
  await writeFile(join(f.dir, "events.jsonl"), old.map((e) => JSON.stringify({ ...e,
    at: "2026-01-01T00:00:00Z" })).join("\n") + "\n");
  await f.send("check");
  assert.match(f.seen.at(-1)!.messages.find((m) => m.role === "tool")!.content!, /outcome_unknown/);
  assert.match(await readFile(join(f.dir, "events.jsonl"), "utf8"), /request_interrupted/);
});

test("an oversized old request is summarized in complete tool steps", async (t) => {
  let summarizeCalls = 0;
  const f = await fixture(t, (data, res) => {
    if (data.messages.some((m) => m.content?.includes("HISTORY_COMPACTION"))) {
      summarizeCalls++; reply(res, summary);
    } else reply(res, "continued");
  }, { contextWindow: 6000 });
  const model = getModel("deepseek", "deepseek-v4-flash");
  const old: object[] = [{ type: "message", role: "user", text: "inspect files", requestId: "old" }];
  for (let i = 0; i < 3; i++) {
    const message = assistantText("", model);
    message.content.push({ type: "toolCall", id: `read-${i}`, name: "read", arguments: { path: `file-${i}` } });
    old.push({ type: "model_message", requestId: "old", message },
      { type: "tool_dispatch", requestId: "old", toolCallId: `read-${i}`, toolName: "read" },
      { type: "tool_result", requestId: "old", toolCallId: `read-${i}`, toolName: "read",
        result: { content: [{ type: "text", text: "evidence-".repeat(1300) }], details: {}, isError: false } });
  }
  old.push({ type: "answer_generated", requestId: "old", text: "complete" },
    { type: "delivery_succeeded", requestId: "old" }, { type: "request_completed", requestId: "old" });
  await writeFile(join(f.dir, "events.jsonl"), old.map((e) => JSON.stringify({ ...e,
    at: "2026-01-01T00:00:00Z" })).join("\n") + "\n");
  await f.send("continue");
  assert.equal(f.replies.at(-1), "continued");
  assert.ok(summarizeCalls >= 2);
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /历史摘要/);
});

test("recent-history compaction reads the complete original archived result", async (t) => {
  const compactInputs: string[] = [];
  let normalCalls = 0;
  const f = await fixture(t, (data, res) => {
    if (data.messages.some((m) => m.content?.includes("HISTORY_COMPACTION"))) {
      compactInputs.push(JSON.stringify(data.messages));
      reply(res, summary);
    } else if (++normalCalls === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "maximum context length exceeded", type: "invalid_request_error" } }));
    } else reply(res, "continued");
  }, { contextWindow: 6000 });
  const log = createRuntimeLog(f.dir);
  const result = { content: [
    { type: "text" as const, text: "specific-evidence-A:" + "龙".repeat(9000) },
    { type: "text" as const, text: "specific-evidence-B:" + "虎".repeat(9000) },
  ],
    details: { source: "file-A" }, isError: false };
  const archive = await log.archive(result);
  const message = assistantText("", getModel("deepseek", "deepseek-v4-flash"));
  message.content.push({ type: "toolCall", id: "source-call", name: "read", arguments: { path: "file-A" } });
  for (const event of [
    { type: "message", role: "user", text: "inspect file", requestId: "old" },
    { type: "model_message", requestId: "old", message },
    { type: "tool_dispatch", requestId: "old", toolCallId: "source-call", toolName: "read", args: { path: "file-A" } },
    { type: "tool_result", requestId: "old", toolCallId: "source-call", toolName: "read", result, archive,
      modelVisible: "archive" },
    { type: "answer_generated", requestId: "old", text: "done" },
    { type: "delivery_succeeded", requestId: "old" },
    { type: "request_completed", requestId: "old" },
  ]) await log.append(event);
  await f.send("continue");
  assert.equal(f.replies.at(-1), "continued", await readFile(join(f.dir, "events.jsonl"), "utf8"));
  assert.ok(compactInputs.length > 1);
  assert.ok(compactInputs.some((input) => input.includes("specific-evidence-A")));
  assert.ok(compactInputs.some((input) => input.includes("specific-evidence-B")));
  assert.ok(compactInputs.every((input) => !input.includes("工具结果已归档")));
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /历史摘要/);
  const files = await readdir(join(f.dir, "checkpoints"));
  assert.ok(files.some((name) => name.endsWith(".json")));
});

test("legacy archive-only events fail clearly when their copy is missing", async (t) => {
  const f = await fixture(t, (_data, res) => reply(res, "unexpected"));
  const log = createRuntimeLog(f.dir);
  const result = { content: [{ type: "text" as const, text: "old evidence" }], details: {}, isError: false };
  const archive = await log.archive(result);
  const message = assistantText("", getModel("deepseek", "deepseek-v4-flash"));
  message.content.push({ type: "toolCall", id: "old-call", name: "read", arguments: { path: "old" } });
  for (const event of [
    { type: "message", role: "user", text: "old", requestId: "old" },
    { type: "model_message", requestId: "old", message },
    { type: "tool_dispatch", requestId: "old", toolCallId: "old-call", toolName: "read", args: { path: "old" } },
    { type: "tool_result", requestId: "old", toolCallId: "old-call", toolName: "read", archive,
      modelVisible: "archive" },
    { type: "request_completed", requestId: "old" },
  ]) await log.append(event);
  await rm(archive.rawPath);
  await f.send("continue");
  assert.equal(f.seen.length, 0);
  assert.match(f.replies.at(-1)!, /工具归档缺失或校验失败/);
});


test("legacy tool progress without text segments gains protocol identity on replay", async (t) => {
  const f = await fixture(t, (_data, res) => reply(res, "checked"));
  const message = assistantText("准备查看目录。", getModel("deepseek", "deepseek-v4-flash"));
  message.content.push({ type: "toolCall", id: "legacy-ls", name: "ls", arguments: { path: "." } });
  const events = [
    { type: "message", role: "user", text: "查看目录", requestId: "old" },
    { type: "model_message", requestId: "old", message },
    { type: "tool_dispatch", requestId: "old", toolCallId: "legacy-ls", toolName: "ls" },
    { type: "tool_result", requestId: "old", toolCallId: "legacy-ls", toolName: "ls",
      result: { content: [{ type: "text", text: "note.md" }], details: {}, isError: false } },
    { type: "request_failed", requestId: "old" },
  ];
  await writeFile(join(f.dir, "events.jsonl"), events.map((event) => JSON.stringify({ ...event, at: "2026-01-01T00:00:00Z" })).join("\n") + "\n");
  await f.send("继续");
  const assistant = f.seen.at(-1)!.messages.find((m) => m.tool_calls?.some((c) => c.id === "legacy-ls"));
  assert.deepEqual(JSON.parse(assistant!.content!), { type: "progress", text: "准备查看目录。" });
  assert.equal(JSON.stringify(f.seen.at(-1)!.messages).split("准备查看目录。").length - 1, 1);
});
