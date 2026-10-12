import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getModel } from '@mariozechner/pi-ai';
import { createRuntimeEventLog } from '../src/runtime/event-log.js';
import { assistantText } from '../src/agent/model-message.js';
import { replayEvents } from '../src/context/projection.js';
import { sourceDigest } from '../src/runtime/event-digest.js';
import { createToolArchive } from '../src/runtime/tool-archive.js';

/** Read-only historical replay compatibility retained for offline diagnostics, never the production executor. */
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
