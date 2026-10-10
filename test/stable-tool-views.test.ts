import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { normalizeTelegramInput } from "../src/channel/telegram/index.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { conversationLog } from "../src/runtime/conversation-log.js";
import type { ToolResult } from "../src/runtime/runtime-types.js";
import { replayEvents } from "../src/context/projection.js";
import { createReplayCache } from "../src/context/replay-cache.js";
import { createTestServer } from "./fixtures/http-server.js";
import { closeFixture } from "./fixtures/cleanup.js";

type WireMessage = { role: string; content?: string; tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
type Payload = { messages: WireMessage[] };

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "stable-tool-views-"));
  const promptFile = join(dir, "prompt.md");
  const inputFile = join(dir, "large.txt");
  await writeFile(promptFile, "Be helpful.");
  await writeFile(inputFile, "PRECISE_ARCHIVED_EVIDENCE:" + "long output ".repeat(1100));
  const seen: Payload[] = [];
  const server = createTestServer(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload: Payload = JSON.parse(body);
    seen.push(payload);
    const last = payload.messages.at(-1)!;
    const path = last.content === "inspect large file" ? inputFile : last.content?.startsWith("recover archive ") ? last.content.slice(16) : undefined;
    const delta = last.role === "user" && path ? { tool_calls: [{ index: 0,
      id: last.content === "inspect large file" ? "large-call" : "explicit-read", type: "function",
      function: { name: "read", arguments: JSON.stringify({ path }) } }] } : { content: "Finished." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta,
      finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const options = { dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}` };
  let agent = await createPiAgent(options);
  let log = await createRuntimeEventLog(dir);
  let host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  let messageId = 0;
  return { dir, seen, get log() { return log; },
    async send(text: string) {
      const terminal = await host.submit(normalizeTelegramInput({ fromId: 42, chatId: 42,
        chatType: "private", messageId: ++messageId, text })).done;
      assert.equal(terminal.type, "run_succeeded", terminal.error);
      return terminal;
    },
    async restart() {
      await agent.close(); log = await createRuntimeEventLog(dir); agent = await createPiAgent(options);
      host = createAgentHost({ dataDir: dir, promptFile, log, agent });
    },
  };
}

test("Telegram runs keep the first bounded tool view across runs, explicit reads and restart without executing history", async (t) => {
  const f = await fixture(t);
  await f.send("inspect large file");
  const live = f.seen.at(-1)!.messages.find((message) => message.tool_call_id === "large-call")!;
  assert.match(live.content!, /工具结果已归档/);
  assert.doesNotMatch(live.content!, /PRECISE_ARCHIVED_EVIDENCE/);
  const event = (await f.log.read()).find((entry) => entry.type === "tool_result" && entry.toolCallId === "large-call")!;
  await f.send("continue");
  assert.deepEqual(f.seen.at(-1)!.messages.find((message) => message.tool_call_id === "large-call"), live);
  await f.send(`recover archive ${(event.archive as { path: string }).path}`);
  const recovered = f.seen.at(-1)!.messages;
  assert.deepEqual(recovered.find((message) => message.tool_call_id === "large-call"), live);
  assert.match(recovered.find((message) => message.tool_call_id === "explicit-read")!.content!, /PRECISE_ARCHIVED_EVIDENCE/);
  await f.restart();
  await f.send("continue after restart");
  assert.deepEqual(f.seen.at(-1)!.messages.find((message) => message.tool_call_id === "large-call"), live);
  assert.equal((await f.log.read()).filter((entry) => entry.type === "tool_dispatch").length, 2);
  const scoped = conversationLog(f.log, "telegram:private:42");
  const current = (await scoped.read()).findLast((entry) => entry.type === "message" && entry.role === "user")!.requestId!;
  const model = getModel("deepseek", "deepseek-v4-flash");
  const cache = createReplayCache(f.dir, "stable-views-comparison");
  const incremental = await cache.replay(scoped, current, model, false);
  const rebuilt = await replayEvents(scoped, current, model, false);
  assert.deepEqual(incremental.units, rebuilt.units);
  await f.send("/reset");
  await f.send("fresh context");
  assert.equal(f.seen.at(-1)!.messages.some((message) => message.role === "tool"), false);
});

test("the durable tool fact contains the exact model-visible content and details with verifiable source provenance", async (t) => {
  const f = await fixture(t);
  await f.send("inspect large file");
  const event = (await f.log.read()).find((entry) => entry.type === "tool_result" && entry.toolCallId === "large-call")!;
  const projection = event.modelProjection as { content: Array<{ type: string; text: string }>; details: unknown;
    sourceDigest: string; digest: string } | undefined;
  assert.ok(projection, "a visibility label alone cannot preserve the actual projection bytes");
  assert.equal(projection.content[0]!.text, f.seen.at(-1)!.messages.find((message) => message.tool_call_id === "large-call")!.content);
  assert.deepEqual(projection.details, {});
  assert.match(projection.sourceDigest, /^[0-9a-f]{64}$/);
  assert.match(projection.digest, /^[0-9a-f]{64}$/);
});

test("replay rejects unsupported, missing or corrupted recorded views instead of silently changing their content", async (t) => {
  const f = await fixture(t);
  await f.send("inspect large file");
  await f.send("continue");
  const scoped = conversationLog(f.log, "telegram:private:42");
  const current = (await scoped.read()).findLast((entry) => entry.type === "message" && entry.role === "user")!.requestId!;
  const unsupported = { ...scoped, read: async () => (await scoped.read()).map((event) =>
    event.type === "tool_result" ? { ...event, modelProjectionVersion: 999 } : event) };
  await assert.rejects(replayEvents(unsupported, current, getModel("deepseek", "deepseek-v4-flash")), /工具.*版本/);
  const corrupted = { ...scoped, read: async () => (await scoped.read()).map((event) =>
    event.type === "tool_result" ? { ...event, modelProjection: {
      ...(event.modelProjection as Record<string, unknown>), content: [{ type: "text", text: "altered recorded view" }],
    } } : event) };
  await assert.rejects(replayEvents(corrupted, current, getModel("deepseek", "deepseek-v4-flash")), /工具.*校验失败/);
  const missing = { ...scoped, read: async () => (await scoped.read()).map((event) =>
    event.type === "tool_result" ? { ...event, modelProjection: undefined } : event) };
  await assert.rejects(replayEvents(missing, current, getModel("deepseek", "deepseek-v4-flash")), /工具.*缺失/);
});

test("a warm replay cache rejects an event result that disagrees with its previously verified archive", async (t) => {
  const f = await fixture(t);
  await f.send("inspect large file");
  await f.send("continue");
  const scoped = conversationLog(f.log, "telegram:private:42");
  const current = (await scoped.read()).findLast((entry) => entry.type === "message" && entry.role === "user")!.requestId!;
  const model = getModel("deepseek", "deepseek-v4-flash");
  const cache = createReplayCache(f.dir, "source-validation");
  await cache.replay(scoped, current, model, false);
  const corrupted = { ...scoped, read: async () => (await scoped.read()).map((event) => {
    if (event.type !== "tool_result") return event;
    // A legacy source fact has archive hashes but no exact-view digest. The
    // event's conflicting inline result must not be masked by derived cache data.
    return { ...event, modelProjectionVersion: 2, modelProjection: undefined,
      result: { ...(event.result as ToolResult), content: [{ type: "text" as const, text: "conflicting source" }] } };
  }) };
  await assert.rejects(replayEvents(corrupted, current, model), /工具归档/);
  await assert.rejects(cache.replay(corrupted, current, model, false), /工具归档/);
});

test("forgetting an original run also excludes its later archive-read copies after restart", async (t) => {
  const f = await fixture(t);
  const original = await f.send("inspect large file");
  const event = (await f.log.read()).find((entry) => entry.type === "tool_result" && entry.toolCallId === "large-call")!;
  const archivePath = (event.archive as { path: string }).path;
  await f.send(`recover archive ${archivePath}`);
  assert.match(f.seen.at(-1)!.messages.find((message) => message.tool_call_id === "explicit-read")!.content!, /PRECISE_ARCHIVED_EVIDENCE/);
  assert.match(String((await f.send(`/forget ${original.runId}`)).result?.text), /已排除/);
  await f.restart();
  await f.send("continue after forgetting");
  assert.doesNotMatch(JSON.stringify(f.seen.at(-1)!.messages), /PRECISE_ARCHIVED_EVIDENCE|large-call/);
  assert.match(f.seen.at(-1)!.messages.find((message) => message.tool_call_id === "explicit-read")!.content!, /已排除/);
  await f.send(`recover archive ${archivePath}`);
  assert.doesNotMatch(JSON.stringify(f.seen.at(-1)!.messages), /PRECISE_ARCHIVED_EVIDENCE/);
  assert.equal((await f.log.read()).filter((entry) => entry.type === "tool_dispatch").length, 3);
  assert.match(JSON.stringify(await f.log.read()), /PRECISE_ARCHIVED_EVIDENCE/, "forgetting preserves original facts for explicit diagnostics");
});
