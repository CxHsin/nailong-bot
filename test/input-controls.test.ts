import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ServerResponse } from "node:http";
import { mkdtemp, writeFile, rm, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import { Response as ApiResponse } from "node-fetch";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { initializeTelegramHostChannel } from "../src/channel/telegram/host-channel.js";
import { createCliChannel } from "../src/cli/cli-channel.js";
import { createTestServer } from "./fixtures/http-server.js";
import { memoryNodes } from "../src/runtime/memory-facts.js";
import { DeliveryRejected } from "../src/application/app-types.js";

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}
function final(res: ServerResponse, text = "completed") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}
type Wire = { messages: Array<{ role: string; content: unknown }> };
const picture = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
async function fixture(t: TestContext, respond: (wire: Wire, count: number, res: ServerResponse) => Promise<void> | void,
  options: { dir?: string; protocol?: "json-text-v2"; contextWindow?: number; compaction?: { trigger: number; target: number }; skills?: string[]; remote?: (item: string) => Promise<string>; send?: (text: string) => Promise<void>; nativeStream?: boolean } = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), "input-controls-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  for (const skill of options.skills ?? []) {
    if (options.dir) continue;
    await mkdir(join(dir, "skills", skill), { recursive: true });
    await writeFile(join(dir, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill} instructions\n---\nINSTRUCTION ${skill} version-one`);
  }
  const wire: Wire[] = [];
  const server = createTestServer(t, async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const part of req) body += part;
    const data = JSON.parse(body);
    if (req.url === "/mcp") {
      let result: unknown;
      if (data.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
      else if (data.method === "tools/list") result = { tools: [{ name: "wait", description: "Wait for external work", inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] } }] };
      else if (data.method === "tools/call") result = { content: [{ type: "text", text: await options.remote!(data.params.arguments.item) }] };
      else { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: data.id, result })); return;
    }
    const input = data as Wire; wire.push(input);
    await respond(input, wire.length, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, deepseekKey: "test", memoryBootstrap: false,
    outputProtocol: options.protocol,
    contextWindow: options.contextWindow, compaction: options.compaction,
    skillSources: options.skills?.length ? [{ name: "personal", path: join(dir, "skills") }] : [],
    mcpServers: options.remote ? [{ name: "remote", url: `http://127.0.0.1:${address.port}/mcp` }] : [],
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  const log = await createRuntimeEventLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  await host.recoverInterrupted();
  const replies: string[] = [];
  const replyWaiters: Array<{ ready: () => boolean; resolve: () => void }> = [];
  const bot = new Bot("123:test", { client: { fetch: async (url) => new ApiResponse(JSON.stringify({ ok: true,
    result: String(url).endsWith("getMe") ? { id: 123, is_bot: true, first_name: "bot", username: "test_bot" } : true })) } });
  const channel = await initializeTelegramHostChannel({ bot, ownerId: 42, host,
    transport: { nativeStream: options.nativeStream, send: async (text) => { await options.send?.(text); replies.push(text); for (const waiter of replyWaiters) if (waiter.ready()) waiter.resolve(); return replies.length; }, draft: async () => {} },
    download: async () => picture, reportFailure: (error) => { throw error; },
    onDelivered: (event, telegramMessageId) => host.recordDelivery(event, { channel: "telegram", telegramMessageId }) });
  t.after(async () => { await channel.finish(); await agent.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  let nextId = 0;
  const send = async (text: string, id = ++nextId, photo = false) => {
    await bot.handleUpdate({ update_id: id, message: { message_id: id, date: 0,
      from: { id: 42, is_bot: false, first_name: "owner" }, chat: { id: 42, type: "private", first_name: "owner" },
      ...(photo ? { caption: text, photo: [{ file_id: "photo", file_unique_id: "photo", width: 1, height: 1 }] } : { text }) } });
    await channel.accepted();
  };
  const stdout: string[] = [];
  const cli = createCliChannel({ host, actor: { id: "owner" }, defaultConversationId: "telegram:private:42",
    stdout: (line) => { stdout.push(line); for (const waiter of replyWaiters) if (waiter.ready()) waiter.resolve(); }, stderr: (line) => { throw new Error(line); } });
  const waitFor = (ready: () => boolean) => ready() ? Promise.resolve() : new Promise<void>((resolve) => { replyWaiters.push({ ready, resolve }); });
  const waitForReplies = (count: number) => waitFor(() => replies.length >= count);
  const waitForReply = (text: string) => waitFor(() => replies.some((reply) => reply.includes(text)));
  const waitForOutput = (text: string) => waitFor(() => stdout.some((line) => line.includes(text)));
  return { dir, wire, log, host, agent, replies, send, channel, cli, stdout, waitForReplies, waitForReply, waitForOutput };
}

test("Telegram accepts Follow-ups immediately and executes each as an ordered independent Run", { timeout: 10000 }, async (t) => {
  const started = barrier(); const finish = barrier(); t.after(finish.release);
  const f = await fixture(t, async (_wire, count, res) => {
    if (count === 1) { started.release(); await finish.reached; }
    final(res, `answer-${count}`);
  });
  await f.send("task-A"); await started.reached;
  await f.send("task-B"); await f.send("task-C");
  await f.waitForReplies(2);
  assert.equal(f.replies.filter((text) => text.includes("已排队")).length, 2);
  assert.equal(f.wire.length, 1);
  finish.release(); await f.channel.finish();
  assert.deepEqual(f.replies.filter((text) => text.startsWith("answer-")), ["answer-1", "answer-2", "answer-3"]);
  const ended = (await f.log.read()).filter((event) => event.type === "run_succeeded");
  assert.equal(new Set(ended.map((event) => event.runId)).size, 3);
  assert.doesNotMatch(JSON.stringify(f.wire[0]), /task-B|task-C/);
  await f.send("task-C", 3); await f.channel.finish();
  assert.equal(f.wire.length, 3);
});

function tools(res: ServerResponse, calls: Array<{ name: string; args: unknown }>) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls.map((call, index) => ({ index, id: `call-${Math.random()}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
}

test("Steer waits for a complete external tool batch and includes images and frozen explicit skills", { timeout: 12000 }, async (t) => {
  const started = barrier(); const finish = barrier(); t.after(finish.release); const executed: string[] = [];
  const f = await fixture(t, (_wire, count, res) => {
    if (count === 1) tools(res, [{ name: "tool_search", args: { query: "wait" } }]);
    else if (count === 2) tools(res, ["one", "two"].map((item) => ({ name: "tool_call", args: { name: "wait", arguments: { item } } })));
    else final(res);
  }, { skills: ["demo", "other"], remote: async (item) => { if (item === "one") { started.release(); await finish.reached; } executed.push(item); return `tool-${item}-complete`; } });
  await f.send("batch-task");
  await Promise.race([started.reached, f.channel.finish().then(async () => {
    throw new Error(`Run ended before the external tool: ${JSON.stringify(f.replies)}`);
  })]);
  await f.send("/steer /demo /other use-image", undefined, true); await f.send("/steer second-correction");
  await f.waitForReplies(2);
  await writeFile(join(f.dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: changed\n---\nNEW-UNACCEPTED-VERSION");
  assert.deepEqual(executed, []); assert.equal(f.wire.length, 2);
  finish.release(); await f.channel.finish();
  assert.deepEqual(executed, ["one", "two"]); assert.equal(f.wire.length, 3);
  const wire = JSON.stringify(f.wire[2]);
  assert.match(wire, /tool-one-complete.*tool-two-complete.*use-image.*second-correction/);
  assert.match(wire, /INSTRUCTION demo version-one/); assert.match(wire, /INSTRUCTION other version-one/);
  assert.ok(wire.includes(`data:image/png;base64,${picture.data}`));
  assert.doesNotMatch(wire, /NEW-UNACCEPTED-VERSION/);
  for (const file of await readdir(join(f.dir, "context-projections"))) await writeFile(join(f.dir, "context-projections", file), "corrupt");
  await f.agent.close();
  const reopened = await fixture(t, (_wire, _count, res) => final(res), { dir: f.dir, skills: ["demo", "other"] });
  await reopened.send("next-task", 100); await reopened.channel.finish();
  assert.match(JSON.stringify(reopened.wire[0]), /INSTRUCTION demo version-one/);
  assert.equal((await reopened.log.read()).filter((event) => event.type === "run_started").length, 2);
  const nodes = memoryNodes(await reopened.log.read(), 42);
  assert.equal(nodes.length, 2);
  assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length);
  assert.match(JSON.stringify(nodes[0]!.messages), /use-image.*second-correction/);
});

test("failure cancels its existing queue, preserves other Conversations and accepts fresh input", { timeout: 12000 }, async (t) => {
  const started = barrier(); const finish = barrier(); t.after(finish.release);
  const f = await fixture(t, async (_wire, count, res) => {
    if (count === 1) { started.release(); await finish.reached; res.writeHead(400).end("provider refused"); }
    else final(res, `answer-${count}`);
  });
  await f.send("failed-prerequisite"); await started.reached;
  await f.send("abandoned-B"); await f.send("abandoned-C");
  const other = f.cli.send("other-conversation", { conversationId: "cli:other" });
  finish.release(); await f.channel.finish(); await other;
  assert.ok(f.replies.some((text) => /失败.*取消 2/.test(text)));
  assert.equal(f.wire.length, 2);
  await f.send("fresh-after-failure"); await f.channel.finish();
  assert.equal(f.wire.length, 3);
  assert.doesNotMatch(JSON.stringify(f.wire[2]), /abandoned-B|abandoned-C|other-conversation/);
  assert.match(JSON.stringify(f.wire[2]), /已失败/);
  assert.doesNotMatch(JSON.stringify(memoryNodes(await f.log.read(), 42)), /abandoned-B|abandoned-C/);
});

test("startup Telegram recovery retries known rejection and suppresses success and unknown delivery on later starts", { timeout: 12000 }, async (t) => {
  const f = await fixture(t, (_wire, _count, res) => final(res));
  await f.log.append({ type: "run_submitted", runId: "interrupted-1", conversationId: "telegram:private:42" });
  await f.log.append({ type: "control_received", runId: "interrupted-steer", phase: "steer", conversationId: "telegram:private:42" });
  await f.agent.close();
  let attempts = 0;
  const reopened = await fixture(t, (_wire, _count, res) => final(res), { dir: f.dir, send: async (text) => {
    if (text.includes("重启恢复") && attempts++ === 0) throw new DeliveryRejected("retry");
  } });
  assert.equal(attempts, 2); assert.equal(reopened.replies.length, 1);
  assert.match(reopened.replies[0]!, /2 项.*重新提交/);
  assert.equal(reopened.wire.length, 0);
  await reopened.host.notifyRecovery("telegram", async () => { throw new Error("must not repeat"); });
  await reopened.log.append({ type: "run_submitted", runId: "interrupted-2", conversationId: "telegram:private:42" });
  await reopened.host.recoverInterrupted();
  let unknown = 0;
  await reopened.host.notifyRecovery("telegram", async () => { unknown++; throw new Error("unknown delivery"); });
  await reopened.host.notifyRecovery("telegram", async () => { unknown++; });
  assert.equal(unknown, 1);
  await reopened.log.append({ type: "request_interrupted", runId: "interrupted-3", requestId: "interrupted-3", reason: "process_restart" });
  await reopened.log.append({ type: "recovery_notice_attempt", noticeId: "crashed-attempt", attemptId: "attempt", inputIds: ["interrupted-3"] });
  await reopened.log.append({ type: "request_interrupted", runId: "interrupted-4", requestId: "interrupted-4", reason: "process_restart" });
  await reopened.host.notifyRecovery("telegram", async (text) => { assert.match(text, /1 项/); });
});

test("replayed Stop input after restart cannot cancel a new active Run", { timeout: 12000 }, async (t) => {
  const f = await fixture(t, (_wire, _count, res) => final(res));
  await f.send("/stop", 71); await f.channel.finish(); await f.agent.close();
  const started = barrier(); const finish = barrier(); t.after(finish.release);
  const reopened = await fixture(t, async (_wire, _count, res) => { started.release(); await finish.reached; final(res); }, { dir: f.dir });
  await reopened.send("fresh-active", 72); await started.reached;
  await reopened.send("/stop", 71);
  finish.release(); await reopened.channel.finish();
  assert.ok(reopened.replies.includes("completed"));
  assert.equal(reopened.replies.some((text) => text.includes("已停止")), false);
});

test("Steer supersedes stale protocol feedback without a spurious extra request", { timeout: 12000 }, async (t) => {
  const started = barrier(); const finish = barrier(); t.after(finish.release);
  const f = await fixture(t, async (_wire, count, res) => {
    if (count === 1) { started.release(); await finish.reached; final(res, "invalid structured output"); }
    else final(res, JSON.stringify({ type: "final", text: "valid-steered-answer" }));
  }, { protocol: "json-text-v2" });
  await f.send("structured-task"); await started.reached;
  await f.send("/steer changed-instruction"); await f.waitForReply("引导已接收");
  finish.release(); await f.channel.finish();
  assert.equal(f.wire.length, 2);
  assert.match(JSON.stringify(f.wire[1]), /changed-instruction/);
  assert.doesNotMatch(JSON.stringify(f.wire[1]!.messages.filter((message) => message.role !== "system")), /运行层协议反馈|invalid structured output/);
  assert.ok(f.replies.includes("valid-steered-answer"));
});

test("compaction and full reconstruction retain applied Steer and explicit stopped state but never cancelled input", { timeout: 20000 }, async (t) => {
  const first = barrier(); const finishFirst = barrier(); const second = barrier(); const finishSecond = barrier();
  t.after(finishFirst.release); t.after(finishSecond.release);
  let reads = 0; let summaries = 0;
  const f = await fixture(t, async (wire, count, res) => {
    if (JSON.stringify(wire.messages[0]).includes("HISTORY_COMPACTION")) {
      summaries++;
      assert.doesNotMatch(JSON.stringify(wire), /never-consumed/);
      final(res, "## Goal\n处理新的资料。\n## Progress\n此前部分工作结束。\n## Constraints\n保留新的要求。\n## Decisions\n后续根据实际资料执行。\n## Next Steps\n继续检查新任务。\n## Critical Context\n精确信息需查询原始日志，工具的完成情况以记录为准；未确认的操作应先检查现状。");
    } else if (count === 1) { first.release(); await finishFirst.reached; final(res); }
    else if (count === 2) { second.release(); await finishSecond.reached; if (!res.destroyed) final(res); }
    else if (reads++ < 8) tools(res, [{ name: "read", args: { path: "source.txt" } }]);
    else final(res);
  }, { contextWindow: 16000, compaction: { trigger: 0.75, target: 0.6 } });
  await writeFile(join(f.dir, "source.txt"), "evidence ".repeat(500));
  await f.send("old-work"); await first.reached;
  await f.send("/steer applied-instruction"); await f.waitForReply("引导已接收");
  finishFirst.release(); await second.reached;
  await f.send("never-consumed-B"); await f.send("never-consumed-C"); await f.send("/stop"); await f.waitForReply("已停止");
  finishSecond.release();
  await f.send("inspect-new-evidence"); await f.channel.finish();
  assert.ok(summaries > 0);
  const last = JSON.stringify(f.wire.at(-1));
  assert.match(last, /已停止/); assert.doesNotMatch(last, /never-consumed/);
  assert.match(JSON.stringify(f.wire[2]), /applied-instruction/);
  assert.ok((await f.log.read()).some((event) => event.type === "context_checkpoint_committed"));
  assert.doesNotMatch(JSON.stringify(memoryNodes(await f.log.read(), 42)), /never-consumed/);
  const before = f.wire.at(-1)!.messages;
  for (const file of await readdir(join(f.dir, "context-projections"))) await writeFile(join(f.dir, "context-projections", file), "corrupt");
  await f.agent.close();
  const reopened = await fixture(t, (_wire, _count, res) => final(res), { dir: f.dir, contextWindow: 16000, compaction: { trigger: 0.75, target: 0.6 } });
  await reopened.send("after-reconstruction", 100); await reopened.channel.finish();
  assert.deepEqual(reopened.wire[0]!.messages.slice(0, before.length), before);
  assert.doesNotMatch(JSON.stringify(reopened.wire), /never-consumed/);
});

test("a prepared Steer rejected by the input budget remains audit-only after failure and reconstruction", { timeout: 15000 }, async (t) => {
  const started = barrier(); const finish = barrier(); t.after(finish.release);
  const f = await fixture(t, async (_wire, count, res) => {
    if (count === 1) { started.release(); await finish.reached; }
    final(res);
  }, { skills: ["demo"], contextWindow: 16000 });
  await f.send("original-task"); await started.reached;
  await writeFile(join(f.dir, "skills", "demo", "SKILL.md"), `---\nname: demo\ndescription: large\n---\n${"NEVER-EFFECTIVE-INSTRUCTION ".repeat(12000)}`);
  await f.send("/steer /demo never-effective-input"); await f.waitForReply("引导已接收");
  finish.release(); await f.channel.finish();
  assert.equal(f.wire.length, 1);
  assert.equal(f.replies.some((text) => text.includes("引导已生效")), false);
  await f.send("fresh-after-budget-failure"); await f.channel.finish();
  assert.equal(f.wire.length, 2);
  assert.doesNotMatch(JSON.stringify(f.wire[1]), /never-effective-input|NEVER-EFFECTIVE-INSTRUCTION/);
  assert.doesNotMatch(JSON.stringify(memoryNodes(await f.log.read(), 42)), /never-effective-input/);
});

test("Stop during a tool batch cancels waiting steering and repeated Stop cancels only newly queued input", { timeout: 12000 }, async (t) => {
  const started = barrier(); const finish = barrier(); t.after(finish.release); const effects: string[] = [];
  const f = await fixture(t, (_wire, count, res) => {
    if (count === 1) tools(res, [{ name: "tool_search", args: { query: "wait" } }]);
    else if (count === 2) tools(res, [{ name: "tool_call", args: { name: "wait", arguments: { item: "effect" } } }]);
    else final(res);
  }, { remote: async (item) => { effects.push(item); started.release(); await finish.reached; return "effect-preserved"; } });
  await f.send("old-tool-task"); await started.reached;
  await f.send("/steer cancelled-steering"); await f.send("/model ds"); await f.send("/reset");
  await f.waitForReply("引导已接收");
  await f.send("/stop"); await f.waitForReply("正在停止");
  const diagnostics = f.cli.send("/kvcache"); await diagnostics;
  await f.send("/steer cancelled-during-stop"); await f.send("/stop");
  await f.send("/steer fresh-during-stop");
  finish.release(); await f.channel.finish();
  assert.deepEqual(effects, ["effect"]);
  const stopped = f.replies.filter((text) => /已取消 \d+ 条待处理输入/.test(text));
  assert.equal(stopped.length, 2, JSON.stringify(f.replies)); assert.match(stopped[0]!, /3 条/); assert.match(stopped[1]!, /1 条/);
  assert.equal(f.wire.length, 3);
  assert.match(JSON.stringify(f.wire[2]), /fresh-during-stop.*|已停止/);
  assert.doesNotMatch(JSON.stringify(f.wire[2]), /cancelled-steering|cancelled-during-stop/);
  assert.equal((await f.log.read()).filter((event) => event.type === "conversation_reset").length, 0);
  await f.send("/stop"); await f.channel.finish();
  assert.ok(f.replies.some((text) => text.includes("当前没有运行中或待处理")));
});

test("idle and queued-only steering becomes ordinary work, including CLI frozen skills and images", { timeout: 12000 }, async (t) => {
  const started = barrier(); const finish = barrier(); t.after(finish.release);
  const f = await fixture(t, async (_wire, count, res) => {
    if (count === 1) { started.release(); await finish.reached; }
    final(res);
  }, { skills: ["demo", "other"] });
  const imagePath = join(f.dir, "photo.png"); await writeFile(imagePath, Buffer.from(picture.data, "base64"));
  const occupying = f.cli.send("occupying", { conversationId: "cli:other" }); await started.reached;
  await f.send("first-queued"); await f.send("/steer /demo /other queued-fallback", undefined, true);
  await f.waitForReply("没有可引导");
  const cliRich = f.cli.send("@demo @other cli-followup", { imagePath });
  await f.waitForOutput("已排队");
  await writeFile(join(f.dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: new\n---\nUNACCEPTED");
  finish.release(); await occupying; await cliRich; await f.channel.finish();
  assert.equal(f.wire.length, 4);
  for (const wire of f.wire.slice(2)) {
    assert.match(JSON.stringify(wire), /INSTRUCTION demo version-one.*INSTRUCTION other version-one/);
    assert.ok(JSON.stringify(wire).includes(picture.data));
    assert.doesNotMatch(JSON.stringify(wire), /UNACCEPTED/);
  }
  await f.send("/steer idle-task"); await f.channel.finish();
  assert.equal(f.wire.length, 5);
  assert.match(JSON.stringify(f.wire[4]), /idle-task/);
});

test("control receipt delivery failures do not repeat model work in either Telegram projection", { timeout: 12000 }, async (t) => {
  for (const nativeStream of [false, true]) {
    const started = barrier(); const finish = barrier(); t.after(finish.release); let rejected = 0;
    const f = await fixture(t, async (_wire, count, res) => {
      if (count === 1) { started.release(); await finish.reached; }
      final(res);
    }, { nativeStream, send: async (text) => {
      if (text.includes("引导已接收") && rejected++ === 0) throw new DeliveryRejected("known rejection");
      if (text.includes("引导已生效")) throw new Error("delivery outcome unknown");
    } });
    await f.send("task"); await started.reached;
    await f.send("/steer correction"); await f.waitForReply("引导已接收");
    finish.release(); await f.channel.finish();
    assert.equal(f.wire.length, 2);
    assert.equal((await f.log.read()).filter((event) => event.type === "run_succeeded").length, 1);
    assert.ok(f.replies.includes("completed"));
  }
});

test("Telegram Stop cancels earlier Follow-ups and queued commands without discarding later work", { timeout: 10000 }, async (t) => {
  const started = barrier(); const finish = barrier(); t.after(finish.release);
  const f = await fixture(t, async (_wire, count, res) => {
    if (count === 1) { started.release(); await finish.reached; }
    if (!res.destroyed) final(res, count === 1 ? "old-answer" : "fresh-answer");
  });
  await f.send("old-task"); await started.reached;
  await f.send("cancelled-B"); await f.send("cancelled-C"); await f.send("/reset");
  await f.send("/stop");
  await f.waitForReply("已停止");
  assert.ok(f.replies.some((reply) => /已停止.*3/.test(reply)));
  await f.send("fresh-task"); finish.release(); await f.channel.finish();
  assert.equal(f.wire.length, 2);
  assert.match(JSON.stringify(f.wire[1]), /fresh-task/);
  assert.doesNotMatch(JSON.stringify(f.wire[1]), /cancelled-B|cancelled-C|\/reset/);
  assert.ok(f.replies.includes("fresh-answer")); assert.ok(!f.replies.includes("old-answer"));
  const facts = await f.log.read();
  assert.equal(facts.filter((event) => event.type === "run_cancelled").length, 4);
  assert.equal(facts.some((event) => event.type === "conversation_reset"), false);
});

test("Telegram Steers apply together to the active Run and survive the next Context Projection", { timeout: 10000 }, async (t) => {
  const started = barrier(); const finish = barrier(); t.after(finish.release);
  const f = await fixture(t, async (_wire, count, res) => {
    if (count === 1) { started.release(); await finish.reached; }
    final(res, `answer-${count}`);
  });
  await f.send("task-A"); await started.reached;
  await f.send("/steer use-red"); await f.send("/steer use-blue-instead");
  await f.waitForReplies(2);
  assert.equal(f.replies.filter((reply) => reply.includes("等待")).length, 2);
  finish.release(); await f.channel.finish();
  assert.equal(f.wire.length, 2);
  const input = JSON.stringify(f.wire[1]);
  assert.ok(input.indexOf("use-red") < input.indexOf("use-blue-instead"));
  assert.equal((await f.log.read()).filter((event) => event.type === "run_started").length, 1);
  assert.equal(f.replies.filter((reply) => reply.includes("引导已生效")).length, 2);
  await f.send("next-task"); await f.channel.finish();
  assert.match(JSON.stringify(f.wire[2]), /use-red.*use-blue-instead/);
});

test("invalid steering is rejected immediately without failing or extending active work", { timeout: 10000 }, async (t) => {
  const started = barrier(); const finish = barrier(); t.after(finish.release);
  const f = await fixture(t, async (_wire, count, res) => {
    if (count === 1) { started.release(); await finish.reached; }
    final(res);
  });
  await f.send("task-A"); await started.reached;
  await f.send("/steer /missing use unavailable skill");
  await f.waitForReply("未知 skill");
  await f.send("/steer"); await f.waitForReply("用法：/steer");
  await f.send("/steer /reset"); await f.waitForReply("控制命令请直接发送");
  await f.send("/stop extra"); await f.waitForReply("用法：/stop");
  finish.release(); await f.channel.finish();
  assert.equal(f.wire.length, 1);
  assert.ok(f.replies.includes("completed"));
  assert.equal(f.replies.some((reply) => reply.includes("引导已生效")), false);
});

test("CLI input keeps reading so Stop reaches the Host before queued ordinary work", { timeout: 10000 }, async (t) => {
  const started = barrier(); const finish = barrier(); t.after(finish.release);
  const f = await fixture(t, async (_wire, count, res) => {
    if (count === 1) { started.release(); await finish.reached; }
    if (!res.destroyed) final(res);
  });
  const done = f.cli.chat((async function* () {
    yield "cli-old-task";
    await started.reached;
    yield "cli-cancelled-task";
    yield "/stop";
  })(), { json: true });
  await done; finish.release();
  assert.equal(f.wire.length, 1);
  const output = f.stdout.map((line) => JSON.parse(line));
  assert.ok(output.some((event) => event.type === "control_completed" && event.phase === "stopped"));
  await f.cli.send("cli-fresh-task");
  assert.equal(f.wire.length, 2);
  assert.doesNotMatch(JSON.stringify(f.wire[1]), /cli-cancelled-task/);
});

