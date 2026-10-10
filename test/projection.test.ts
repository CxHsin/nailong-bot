import { createTestServer } from "./fixtures/http-server.js";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createTelegramHostFixture } from "./fixtures/telegram-host.js";
import type { PiAgentOptions } from "../src/agent/pi-agent.js";
import { assistantText } from "../src/agent/model-message.js";
import { getModel } from "@mariozechner/pi-ai";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import type { StoredEvent, ToolArchive } from "../src/runtime/runtime-types.js";
import { closeFixture } from "./fixtures/cleanup.js";
import { replayEvents } from "../src/context/projection.js";
import { createContextProjection } from "../src/context/context-budget.js";
import { createCheckpointStore } from "../src/context/checkpoint.js";
import { recordInterruptedRuns } from "../src/runtime/startup-recovery.js";
import { createToolArchive } from "../src/runtime/tool-archive.js";
import { sourceDigest } from "../src/runtime/event-digest.js";
import { memoryNodes } from "../src/runtime/memory-facts.js";

type WireMessage = { role: string; content?: string; tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
type Payload = { messages: WireMessage[]; input?: unknown; tools?: unknown[]; max_tokens?: number; max_completion_tokens?: number };
function reply(res: ServerResponse, content: string, call?: { id: string; name: string; args: object }) {
  const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: {
    name: call.name, arguments: JSON.stringify(call.args),
  } }] } : { content };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta,
    finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}
function nativeText(res: ServerResponse, id: string, phase: "commentary" | "final_answer", text: string) {
  const item = { type: "message", id, role: "assistant", status: "completed", phase,
    content: [{ type: "output_text", text, annotations: [] }] };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end([{ type: "response.created", response: { id: "response", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, item_id: id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: id, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response", status: "completed", usage: { input_tokens: 50, output_tokens: 10 } } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}
async function fixture(t: TestContext, respond: (data: Payload, res: ServerResponse) => void,
  options: Partial<PiAgentOptions> | ((baseUrl: string) => Partial<PiAgentOptions>) = {}) {
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const agentOptions = { dataDir: dir, promptFile, deepseekKey: "test",
    modelBaseUrl: baseUrl, ...(typeof options === "function" ? options(baseUrl) : options) };
  const app = await createTelegramHostFixture(t, { agentOptions: { memoryBootstrap: false, ...agentOptions } });
  t.after(() => closeFixture({ server, dir, shutdown: () => app.close() }));
  return { dir, seen, replies: app.sent, get log() { return app.rootLog; },
    send: (text: string) => app.send(text), restart: () => app.restart(), failures: app.failures };
}

async function historicalFixture(t: TestContext, legacySource?: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "historical-projection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await legacySource?.(dir);
  const log = await createRuntimeEventLog(dir);
  const model = getModel("deepseek", "deepseek-v4-flash");
  return { dir, log, model, async replay(requestId = "current") {
    return (await replayEvents(log, requestId, model, true)).units.flatMap((unit) => unit.messages);
  } };
}

const summary = "## Goal\nContinue the task.\n## Progress\nEarlier work completed.\n## Constraints\nKeep the user's requirements.\n## Decisions\nPreserve evidence.\n## Next Steps\nContinue recent work.\n## Critical Context\nUse the original log for exact details.";

test("real Responses commentary continues in the current Run while transient feedback is excluded after restart", async (t) => {
  let calls = 0;
  const f = await fixture(t, (_data, res) => {
    const count = ++calls;
    nativeText(res, `phase-${count}`, count === 1 ? "commentary" : "final_answer", count === 1 ? "已确认日期，继续核查。" : "finished");
  }, (baseUrl) => ({ modelConfiguration: { defaultModel: "phase", models: [{ alias: "phase", api: "openai-responses",
    model: "phase-test", apiKey: "test", baseUrl, toolSearch: "compat" }] } }));
  await f.send("first user");
  assert.equal(f.seen.length, 2);
  assert.match(JSON.stringify(f.seen[1]!.input), /已确认日期/);
  await f.restart();
  await f.send("next user");
  assert.doesNotMatch(JSON.stringify(f.seen[2]!.input), /运行层协议反馈/);
  assert.match(JSON.stringify(f.seen[2]!.input), /已确认日期/);
  assert.equal(f.replies.at(-1), "finished");
  assert.equal((await f.log.read()).filter((event) => event.type === "protocol_feedback").length, 1);
});

test("distinct native commentary without tools stops after twelve steps without a learned final answer", async (t) => {
  let calls = 0;
  const f = await fixture(t, (_data, res) => {
    const count = ++calls;
    nativeText(res, `commentary-${count}`, "commentary", `已核对第 ${count} 项资料，继续检查。`);
  }, (baseUrl) => ({ modelConfiguration: { defaultModel: "phase", models: [{ alias: "phase", api: "openai-responses",
    model: "phase-test", apiKey: "test", baseUrl, toolSearch: "compat" }] } }));
  await f.send("核查资料并执行实际操作");
  const facts = await f.log.read();
  assert.equal(calls, 12);
  const commentary = facts.filter((event) => event.type === "text_finalized" && event.phase === "commentary");
  assert.equal(commentary.length, 12);
  assert.equal(new Set(commentary.map((event) => event.text)).size, 12);
  assert.ok(!facts.some((event) => event.type === "tool_dispatch" || event.type === "run_succeeded" || event.type === "delivery_succeeded" || event.type === "memory_learning_committed"));
  assert.match(String(facts.find((event) => event.type === "run_failed")?.error), /连续十二步未执行工具或提交最终答复/);
  assert.deepEqual(memoryNodes(facts, 42).flatMap((node) => node.messages.filter((message) => message.role === "assistant")), []);
  assert.match(f.replies.at(-1) ?? "", /处理失败/);
});

test("restart replays tool exchanges, including errors, without duplicating calls", async (t) => {
  const f = await fixture(t, (data, res) => {
    const last = data.messages.at(-1)!;
    if (last.role === "user" && last.content === "read missing") {
      reply(res, "", { id: "same-id", name: "read", args: { path: "missing.txt" } });
    } else reply(res, "finished");
  });
  await f.send("read missing");
  assert.equal(f.replies.at(-1), "finished", JSON.stringify(await f.log.read()));
  await f.restart();
  await f.send("continue");
  const history = f.seen.at(-1)!.messages;
  assert.equal(history.flatMap((m) => m.tool_calls ?? []).length, 1);
  assert.equal(history.filter((m) => m.role === "tool").length, 1);
  assert.match(history.find((m) => m.role === "tool")!.content!, /ENOENT/);
  assert.equal(history.at(-1)!.content, "continue");
  await f.send("/reset");
  await f.send("new");
  assert.equal(f.seen.at(-1)!.messages.filter((m) => m.content === "new").length, 1);
  const active = f.seen.at(-1)!.messages.filter((m) => !m.content?.startsWith("长期记忆原文引用"));
  assert.doesNotMatch(JSON.stringify(active), /read missing|same-id/);
  assert.equal(f.seen.at(-1)!.messages.some((m) => m.role === "tool"), false);
  assert.match(JSON.stringify(await f.log.read()), /same-id/);
});

test("a single long tool chain compacts settled earlier steps while keeping the current goal", async (t) => {
  let tools = 0;
  let compacted = false;
  const f = await fixture(t, (data, res) => {
    if (data.messages.some((m) => m.content?.includes("HISTORY_COMPACTION"))) {
      compacted = true; reply(res, summary);
    } else if (tools < 8) reply(res, "", { id: `read-${tools++}`, name: "read", args: { path: "source.txt" } });
    else reply(res, "chain finished");
  }, { contextWindow: 16000, compaction: { trigger: 0.75, target: 0.6 } });
  await writeFile(join(f.dir, "source.txt"), "evidence ".repeat(500));
  await f.send("inspect all evidence");
  assert.equal(f.replies.at(-1), "chain finished", JSON.stringify(await f.log.read()));
  assert.equal(compacted, true);
  const final = f.seen.at(-1)!.messages;
  assert.equal(final.filter((m) => m.content === "inspect all evidence").length, 1);
  const ids = final.flatMap((m) => m.tool_calls ?? []).map((c) => c.id);
  assert.ok(final.filter((m) => m.role === "tool").every((m) => ids.includes(m.tool_call_id!)));
});

test("an input that cannot be split is rejected before provider dispatch at a per-model ratio", async (t) => {
  const f = await fixture(t, (_data, res) => reply(res, "should not dispatch"), {
    memoryBootstrap: true, contextWindow: 6000, modelBudgetRatios: { "deepseek/deepseek-flash": 0.4 },
  });
  await f.send("large current input " + "x".repeat(7000));
  assert.equal(f.seen.length, 0);
  assert.match(f.replies.at(-1)!, /处理失败/);
  const events = await f.log.read();
  const input = events.find((event) => event.type === "message" && event.role === "user");
  const failure = events.find((event) => event.type === "request_failed" && event.requestId === input?.requestId);
  assert.match(String(failure?.error), /预算/);
  assert.ok(events.some((event) => event.type === "memory_bootstrap_started"), "explicit production bootstrap option remains enabled");
  assert.ok((await readdir(f.dir)).includes("runtime-v2.sqlite"), "projection fixture must use the production SQLite store");
  assert.ok(!(await readdir(f.dir)).includes("events.jsonl"), "ordinary projection runs must not write JSONL");
});

test("recorded archived views remain bounded on restart and corrupt copies recover from complete source events", async (t) => {
  const f = await fixture(t, (data, res) => {
    if (data.messages.at(-1)?.content === "read large") {
      reply(res, "", { id: "large", name: "read", args: { path: "large.txt" } });
    } else reply(res, "finished");
  });
  await writeFile(join(f.dir, "large.txt"), "big-evidence ".repeat(2000));
  await f.send("read large");
  const firstView = f.seen.at(-1)!.messages.find((m) => m.role === "tool")!;
  await f.restart();
  await f.send("continue");
  const tool = f.seen.at(-1)!.messages.find((m) => m.role === "tool")!;
  assert.deepEqual(tool, firstView);
  assert.match(tool.content!, /工具结果已归档/);
  assert.doesNotMatch(tool.content!, /big-evidence/);
  const events = await f.log.read();
  const result = events.find((e) => e.type === "tool_result");
  assert.equal(result?.modelVisible, "archive");
  assert.ok(result?.archive);
  const archive = result.archive as ToolArchive;
  await writeFile(archive.rawPath, "corrupted");
  for (const file of await readdir(join(f.dir, "context-projections"))) await writeFile(join(f.dir, "context-projections", file), "corrupt projection");
  await f.restart();
  await f.send("check again");
  assert.equal(f.replies.at(-1), "finished");
  assert.match(await readFile(archive.rawPath, "utf8"), /big-evidence/);
  await rm(join(f.dir, "tool-results"), { recursive: true, force: true });
  for (const file of await readdir(join(f.dir, "context-projections"))) await writeFile(join(f.dir, "context-projections", file), "corrupt projection");
  await f.restart();
  await f.send("recover missing archive directory");
  assert.equal(f.replies.at(-1), "finished");
  assert.match(await readFile(archive.rawPath, "utf8"), /big-evidence/);
});

test("provider overflow compacts and retries the rejected model step once", async (t) => {
  let normal = 0; let overflow = false;
  const f = await fixture(t, (data, res) => {
    if (data.messages.some((m) => m.content?.includes("HISTORY_COMPACTION"))) reply(res, summary);
    else if (overflow && ++normal === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "maximum context length exceeded", type: "invalid_request_error" } }));
    } else reply(res, "recovered");
  });
  await f.send("old goal " + "a".repeat(1500));
  overflow = true;
  await f.send("continue");
  assert.equal(f.replies.at(-1), "recovered");
  assert.equal(normal, 2);
  assert.match(JSON.stringify(f.seen.at(-1)!.messages), /历史摘要/);
});

test("a second provider overflow fails after one retry", async (t) => {
  let normal = 0; let overflow = false;
  const f = await fixture(t, (data, res) => {
    if (data.messages.some((m) => m.content?.includes("HISTORY_COMPACTION"))) reply(res, summary);
    else if (overflow) {
      normal++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "maximum context length exceeded", type: "invalid_request_error" } }));
    } else reply(res, "previous answer " + "b".repeat(1500));
  });
  await f.send("old goal " + "a".repeat(1500));
  overflow = true;
  await f.send("continue");
  assert.equal(normal, 2);
  assert.match(f.replies.at(-1)!, /处理失败/);
  assert.match(String((await f.log.read()).findLast((event) => event.type === "run_failed")?.error), /溢出重试失败/);
});

test("protocol feedback corrects only its current Run and is excluded from compaction input", async (t) => {
  const f = await historicalFixture(t);
  const log = f.log;
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
  const oldStore = createCheckpointStore(f.dir, "structured-text-v1");
  await oldStore.save({ boundary: "initial", through: events.length,
    sourceDigest: sourceDigest(events), lastEventDigest: sourceDigest(events.at(-1)), summaryStrategy: "structured-text-v1",
    summary: "STALE_DERIVED_PROTOCOL_FEEDBACK", model: "deepseek/deepseek-flash", ratio: 0.82 });
  assert.equal(await oldStore.load(replay.boundary, events), undefined);
  assert.equal((await log.read()).filter((event) => event.type === "protocol_feedback").length, 2);
  assert.ok((await log.read()).every((event) => event.conversationId === undefined));
});

test("historical recent-range replay retains complete tool pairs and settled text without reading older archives", async (t) => {
  const f = await historicalFixture(t);
  const model = f.model;
  for (let index = 0; index < 5; index++) {
    const id = `round-${index}`;
    const message = assistantText("", model);
    message.content.push({ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } });
    const result = { content: [{ type: "text" as const, text: "ENOENT" }], details: {}, isError: true };
    const archive = await f.log.archive(result);
    await f.log.appendBatch([
      { type: "message", role: "user", requestId: id, text: id },
      { type: "model_message", requestId: id, modelStepId: `${id}-step`, message },
      { type: "tool_dispatch", requestId: id, toolCallId: id, toolName: "read" },
      { type: "tool_result", requestId: id, toolCallId: id, toolName: "read", result, archive, modelVisible: "archive" },
      { type: "answer_generated", requestId: id, text: "complete answer" },
      { type: "delivery_succeeded", requestId: id }, { type: "request_completed", requestId: id },
    ]);
  }
  await f.log.append({ type: "message", role: "user", requestId: "current", text: "continue recent turns" });
  const messages = await f.replay();
  assert.doesNotMatch(JSON.stringify(messages), /round-0|round-1/);
  for (const id of ["round-2", "round-3", "round-4"]) {
    assert.equal(messages.flatMap((message) => message.role === "assistant" ? message.content : []).filter((part) => part.type === "toolCall" && part.id === id).length, 1);
    assert.equal(messages.filter((message) => message.role === "toolResult" && message.toolCallId === id).length, 1);
  }
  assert.equal(messages.filter((message) => message.role === "assistant" && JSON.stringify(message.content).includes("complete answer")).length, 3);
  const log = f.log;
  const currentId = (await log.read()).findLast((event) => event.type === "message" && event.role === "user")!.requestId!;
  const older = new Set((await log.read()).filter((event) => event.type === "tool_result" && ["round-0", "round-1"].includes(String(event.toolCallId)))
    .map((event) => sourceDigest(event.archive)));
  await replayEvents({ ...log, recoverArchive: async (archive, source) => {
    assert.ok(!older.has(sourceDigest(archive)), "outside-window archives must not be read");
    return log.recoverArchive(archive, source);
  } }, currentId, model);
});

test("a stopped dispatched tool is projected as unknown without persisting a fabricated result", async (t) => {
  const f = await historicalFixture(t);
  const message = assistantText("checking", getModel("deepseek", "deepseek-v4-flash"));
  message.content.push({ type: "toolCall", id: "uncertain", name: "write", arguments: { path: "note", content: "text" } });
  const events = [
    { type: "message", role: "user", text: "save", requestId: "old" },
    { type: "model_message", requestId: "old", modelStepId: "old-step", message },
    { type: "tool_dispatch", requestId: "old", toolCallId: "uncertain", toolName: "write" },
    { type: "request_failed", requestId: "old" },
  ].map((e) => ({ ...e, at: "2026-01-01T00:00:00Z" }));
  await f.log.appendBatch(events);
  await f.log.append({ type: "message", role: "user", requestId: "current", text: "check status" });
  const messages = await f.replay();
  assert.match(JSON.stringify(messages.find((message) => message.role === "toolResult")), /outcome_unknown/);
  assert.equal((await f.log.read()).some((event) => event.type === "tool_result"), false);
});

test("a result before matching dispatch is not replayed as an executed tool", async (t) => {
  const f = await historicalFixture(t);
  const message = assistantText("", getModel("deepseek", "deepseek-v4-flash"));
  message.content.push({ type: "toolCall", id: "orphan", name: "write", arguments: { path: "note" } });
  const old = [
    { type: "message", role: "user", text: "save", requestId: "old" },
    { type: "model_message", requestId: "old", modelStepId: "old-step", message },
    { type: "tool_result", requestId: "old", toolCallId: "orphan", toolName: "write",
      result: { content: [{ type: "text", text: "success" }], details: {}, isError: false } },
    { type: "tool_dispatch", requestId: "old", toolCallId: "orphan", toolName: "write" },
    { type: "request_failed", requestId: "old" },
  ];
  await f.log.appendBatch(old);
  await f.log.append({ type: "message", role: "user", requestId: "current", text: "check" });
  const messages = await f.replay();
  assert.equal(messages.some((message) => message.role === "toolResult"), false);
  assert.equal(messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === "orphan")), false);
});

test("a crashed dispatched tool is marked interrupted before its outcome becomes unknown", async (t) => {
  const f = await historicalFixture(t);
  const message = assistantText("", getModel("deepseek", "deepseek-v4-flash"));
  message.content.push({ type: "toolCall", id: "pending", name: "write", arguments: { path: "note" } });
  const old = [
    { type: "message", role: "user", text: "save", requestId: "old" },
    { type: "request_started", requestId: "old" },
    { type: "model_message", requestId: "old", modelStepId: "old-step", message },
    { type: "tool_dispatch", requestId: "old", toolCallId: "pending", toolName: "write" },
  ];
  await f.log.appendBatch(old);
  await recordInterruptedRuns(f.log);
  await f.log.append({ type: "message", role: "user", requestId: "current", text: "check" });
  assert.match(JSON.stringify((await f.replay()).find((message) => message.role === "toolResult")), /outcome_unknown/);
  assert.match(JSON.stringify(await f.log.read()), /request_interrupted/);
});

test("an oversized legacy tool step fails clearly without repeated summaries", async (t) => {
  let summarizeCalls = 0;
  const f = await historicalFixture(t);
  const model = getModel("deepseek", "deepseek-v4-flash");
  const old: Omit<StoredEvent, "at">[] = [{ type: "message", role: "user", text: "inspect files", requestId: "old" }];
  for (let i = 0; i < 3; i++) {
    const message = assistantText("", model);
    message.content.push({ type: "toolCall", id: `read-${i}`, name: "read", arguments: { path: `file-${i}` } });
    old.push({ type: "model_message", requestId: "old", modelStepId: `old-step-${i}`, message },
      { type: "tool_dispatch", requestId: "old", toolCallId: `read-${i}`, toolName: "read" },
      { type: "tool_result", requestId: "old", toolCallId: `read-${i}`, toolName: "read",
        result: { content: [{ type: "text", text: "evidence-".repeat(1300) }], details: {}, isError: false } });
  }
  old.push({ type: "answer_generated", requestId: "old", text: "complete" },
    { type: "delivery_succeeded", requestId: "old" }, { type: "request_completed", requestId: "old" });
  await f.log.appendBatch(old);
  await f.log.append({ type: "message", role: "user", requestId: "current", text: "continue" });
  const projection = createContextProjection({ log: f.log, dataDir: f.dir, requestId: "current", summarize: async () => { summarizeCalls++; return summary; } });
  await assert.rejects(projection.project({ ...model, contextWindow: 6000, maxTokens: 1500 }, { systemPrompt: "helpful", messages: [] }), /预算/);
  assert.equal(summarizeCalls, 0, "an unbounded legacy tool result cannot fit summary input");
});

test("compaction summarizes the stable bounded view and keeps full originals archived", async (t) => {
  const compactInputs: string[] = [];
  let normalCalls = 0;
  const f = await historicalFixture(t);
  const log = f.log;
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
    { type: "model_message", requestId: "old", modelStepId: "old-step", message },
    { type: "tool_dispatch", requestId: "old", toolCallId: "source-call", toolName: "read", args: { path: "file-A" } },
    { type: "tool_result", requestId: "old", toolCallId: "source-call", toolName: "read", result, archive,
      modelVisible: "archive" },
    { type: "answer_generated", requestId: "old", text: "done" },
    { type: "delivery_succeeded", requestId: "old" },
    { type: "request_completed", requestId: "old" },
  ]) await log.append(event);
  await log.append({ type: "message", role: "user", requestId: "current", text: "continue" });
  const projection = createContextProjection({ log, dataDir: f.dir, requestId: "current", compaction: { trigger: 0.75, target: 0.6 },
    summarize: async (context) => { compactInputs.push(JSON.stringify(context.messages)); return summary; } });
  const projected = await projection.project({ ...f.model, contextWindow: 16000, maxTokens: 2000 }, { systemPrompt: "helpful", messages: [] }, true);
  assert.equal(compactInputs.length, 1);
  assert.ok(compactInputs.every((input) => !input.includes("specific-evidence-A") && !input.includes("specific-evidence-B")));
  assert.ok(compactInputs.some((input) => input.includes("工具结果已归档")));
  assert.match(JSON.stringify(projected.context.messages), /历史摘要/);
  assert.match(await readFile(archive.rawPath, "utf8"), /specific-evidence-A/);
  assert.ok((await readdir(join(f.dir, "checkpoints"))).some((name) => name.endsWith(".json")));
});

test("legacy JSONL archive-only events imported into SQLite fail clearly when their copy is missing", async (t) => {
  let archive!: Awaited<ReturnType<ReturnType<typeof createToolArchive>["archive"]>>;
  const f = await historicalFixture(t, async (dir) => {
    const result = { content: [{ type: "text" as const, text: "old evidence" }], details: {}, isError: false };
    archive = await createToolArchive(dir).archive(result);
    const message = assistantText("", getModel("deepseek", "deepseek-v4-flash"));
    message.content.push({ type: "toolCall", id: "old-call", name: "read", arguments: { path: "old" } });
    const events = [
      { type: "message", role: "user", text: "old", requestId: "old" },
      { type: "model_message", requestId: "old", message },
      { type: "tool_dispatch", requestId: "old", toolCallId: "old-call", toolName: "read", args: { path: "old" } },
      { type: "tool_result", requestId: "old", toolCallId: "old-call", toolName: "read", archive, modelVisible: "archive" },
      { type: "request_completed", requestId: "old" },
    ];
    await writeFile(join(dir, "events.jsonl"), events.map((event) => JSON.stringify({ ...event, at: "2026-01-01T00:00:00Z" })).join("\n") + "\n");
  });
  await rm(archive.rawPath);
  await f.log.append({ type: "message", role: "user", requestId: "current", text: "continue" });
  await assert.rejects(f.replay(), /工具归档缺失或校验失败/);
  assert.ok((await f.log.read()).every((event) => event.conversationId === undefined));
});

test("legacy JSONL tool progress imported into SQLite gains protocol identity on replay", async (t) => {
  const message = assistantText("准备查看目录。", getModel("deepseek", "deepseek-v4-flash"));
  message.content.push({ type: "toolCall", id: "legacy-ls", name: "ls", arguments: { path: "." } });
  const events = [
    { type: "message", role: "user", text: "查看目录", requestId: "old" },
    { type: "model_message", requestId: "old", modelStepId: "old-step", message },
    { type: "tool_dispatch", requestId: "old", toolCallId: "legacy-ls", toolName: "ls" },
    { type: "tool_result", requestId: "old", toolCallId: "legacy-ls", toolName: "ls",
      result: { content: [{ type: "text", text: "note.md" }], details: {}, isError: false } },
    { type: "request_failed", requestId: "old" },
  ];
  const f = await historicalFixture(t, async (dir) => {
    await writeFile(join(dir, "events.jsonl"), events.map((event) => JSON.stringify({ ...event, at: "2026-01-01T00:00:00Z" })).join("\n") + "\n");
  });
  await f.log.append({ type: "message", role: "user", requestId: "current", text: "继续" });
  const messages = await f.replay();
  const assistant = messages.find((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === "legacy-ls"));
  assert.ok(assistant && assistant.role === "assistant");
  assert.deepEqual(JSON.parse(assistant.content.filter((part) => part.type === "text").map((part) => part.text).join("")), { type: "progress", text: "准备查看目录。" });
  assert.equal(JSON.stringify(messages).split("准备查看目录。").length - 1, 1);
  assert.ok((await f.log.read()).every((event) => event.conversationId === undefined));
});
