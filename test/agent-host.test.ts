import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";

test("Host controls are queued without invoking the model or entering model history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.md");
  await writeFile(promptFile, "default prompt");
  const log = createRuntimeLog(dir);
  const prompts: Array<string | undefined> = [];
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent: { answer: async (_messages, request) => {
    prompts.push(request.botPrompt); return "answer";
  } } });
  const send = async (text: string, conversationId = "c1") => {
    const handle = host.submit({ actor: { id: "owner" }, conversationId, parts: [{ type: "text", text }] });
    return (await handle.done).result;
  };
  assert.match(String((await send("/help"))?.text), /\/kvcache/);
  assert.match(String((await send("/kvcache"))?.text), /暂无/);
  assert.match(String((await send("/kvcache unexpected"))?.text), /用法/);
  assert.match(String((await send("/missing"))?.text), /未知命令/);
  assert.match(String((await send("/kvcache!"))?.text), /用法|未知命令/);
  assert.match(String((await send("/?"))?.text), /用法|未知命令/);
  await send("/prompt set custom prompt");
  await send("first");
  await send("other", "c2");
  await send("/reset");
  await send("/prompt reset");
  await send("new");
  assert.deepEqual(prompts, ["custom prompt", undefined, undefined]);
  const events = await log.read();
  assert.deepEqual(events.filter((e) => e.type === "message").map((e) => e.text), ["first", "other", "new"]);
  assert.ok(events.some((e) => e.type === "conversation_reset" && e.conversationId === "c1"));
});

test("legacy reset receipts retain their scoped boundary without reviving control inputs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "host-legacy-reset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  for (const event of [
    { type: "message", role: "user", chatId: 42, text: "old secret" },
    { type: "message", role: "assistant", text: "old answer" },
    { type: "message", role: "user", chatId: 42, text: "/reset" },
    { type: "reset" },
    { type: "message", role: "user", chatId: 99, text: "other conversation" },
  ]) await log.append(event);
  const histories: string[][] = [];
  const host = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log, agent: {
    answer: async (messages) => { histories.push(messages.map((message) => message.text)); return "answer"; },
  } });
  await host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "fresh" }).done;
  await host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:99", text: "continued" }).done;
  assert.deepEqual(histories, [["fresh"], ["other conversation", "continued"]]);
  assert.ok((await log.read()).some((event) => event.type === "reset" && event.conversationId === undefined));
});

test("Host settles delivered memory once and controls do not reinforce it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "host-memory-delivery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log, agent: {
    answer: async (_messages, request) => {
      await request.log.append({ type: "memory_recalled", requestId: request.id, snapshotId: "memory-snapshot", candidates: [] });
      return "answer";
    },
  } });
  const model = await host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "remember" }).done;
  assert.equal((await log.read()).some((event) => event.type === "memory_learned"), false);
  await host.recordDelivery(model, { channel: "cli" });
  await host.recordDelivery(model, { channel: "telegram", telegramMessageId: 123 });
  const learned = (await log.read()).filter((event) => event.type === "memory_learned");
  assert.equal(learned.length, 1);
  assert.equal(learned[0]!.requestId, model.runId);
  assert.equal(learned[0]!.conversationId, "c1");
  const control = await host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "/help" }).done;
  await host.recordDelivery(control, { channel: "cli" });
  assert.equal((await log.read()).filter((event) => event.type === "memory_learned").length, 1);
});

test("reset is queued behind active work and cancelled consumption and legacy ownership stay visible", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cache-barrier-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const histories: string[][] = [];
  const host = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log, agent: { answer: async (messages, request) => {
    histories.push(messages.map((message) => message.text));
    await request.log.append({ type: "model_usage", requestId: request.id, callId: "call", purpose: "execution", usageAvailable: true,
      usage: { input: 0, cacheRead: 10 } });
    if (histories.length === 1) { started(); await blocked; }
    return "answer";
  } } });
  const run = host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "blocked" });
  await ready;
  const reset = host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "/reset" });
  const next = host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "fresh" });
  assert.equal((await log.read()).some((event) => event.type === "conversation_reset"), false);
  await run.cancel(); release();
  assert.equal((await run.done).type, "run_cancelled"); await reset.done; await next.done;
  assert.deepEqual(histories, [["blocked"], ["fresh"]]);
  const result = await host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "/kvcache" }).done;
  const report = result.result?.cache as { recent: Array<{ state: string }>; execution: { hit: number; measured: number } };
  assert.deepEqual(report.recent.map((row) => row.state), ["succeeded", "cancelled"]);
  assert.equal(report.execution.hit, 20); assert.equal(report.execution.measured, 2);
  await log.append({ type: "message", role: "user", requestId: "legacy", chatId: 42, text: "old" });
  await log.append({ type: "model_message", requestId: "legacy", modelStepId: "legacy-call", message: { usage: { input: 5, cacheRead: 15 } } });
  await log.append({ type: "request_completed", requestId: "legacy" });
  await log.append({ type: "model_message", modelStepId: "orphan", message: { usage: { input: 100, cacheRead: 100 } } });
  const legacy = await host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "/kvcache" }).done;
  const restored = legacy.result?.cache as { execution: { hit: number; miss: number }; unassignedCalls: number };
  assert.equal(restored.execution.hit, 15); assert.equal(restored.execution.miss, 5); assert.equal(restored.unassignedCalls, 1);
});

test("Host cache report uses five ended model Runs when idle and weighted durable Conversation totals", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "host-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  let next = 0;
  const host = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log, agent: { answer: async (_messages, request) => {
    next++;
    const counts = next === 1 ? [[900, 100]] : next === 2 ? [[0, 100]] : next === 3 ? [[]] : next === 4 ? [[300, 100], [100, 0]] : [[]];
    for (const [index, count] of counts.entries()) {
      const modelStepId = `${request.id}:${index}`;
      await request.log.append({ type: "model_step_started", requestId: request.id, modelStepId });
      const message = { role: "assistant", stopReason: "stop", provider: "deepseek", model: "deepseek-flash",
        usage: count.length ? { cacheRead: count[0], input: count[1], output: 5, totalTokens: count[0]! + count[1]! + 5 } : undefined };
      await request.log.append({ type: "model_message", requestId: request.id, modelStepId, message });
      // A replayed copy must not create extra consumption.
      await request.log.append({ type: "model_message", requestId: request.id, modelStepId, message });
    }
    if (next === 4) await request.log.append({ type: "model_usage", requestId: request.id, callId: "summary-1", purpose: "summary",
      provider: "deepseek", model: "deepseek-flash", usageAvailable: true, usage: { input: 20, cacheRead: 10, output: 2 } });
    if (next === 5) throw new Error("provider failed without usage");
    return "answer";
  } } });
  const send = async (text: string, conversationId = "c1") => {
    const run = host.submit({ actor: { id: "owner" }, conversationId, text });
    return { id: run.runId, terminal: await run.done };
  };
  const runs = [];
  for (let index = 0; index < 5; index++) runs.push(await send(`work-${index}`));
  await send("/help");
  const report = (await send("/kvcache")).terminal.result?.cache as {
    recent: Array<{ runId: string; state: string; execution: { hit: number; miss: number; measured: number; calls: number } }>;
    execution: { hit: number; miss: number; input: number; hitRate: number; calls: number; measured: number };
    auxiliary: { hit: number; miss: number };
  };
  assert.deepEqual(report.recent.map((run) => run.runId), [runs[4]!.id, runs[3]!.id, runs[2]!.id, runs[1]!.id, runs[0]!.id]);
  assert.equal(report.recent[0]!.state, "failed");
  assert.deepEqual(report.execution, { hit: 1300, miss: 300, input: 1600, hitRate: 0.8125, calls: 6, measured: 4, pending: 0 });
  assert.equal(report.auxiliary.hit, 10);
  assert.equal(report.auxiliary.miss, 20);
  await send("/reset");
  const restored = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log: createRuntimeLog(dir), agent: { answer: async () => { throw new Error("controls must not invoke model"); } } });
  const after = await restored.submit({ actor: { id: "owner" }, conversationId: "c1", text: "/kvcache" }).done;
  assert.deepEqual(after.result?.cache, report);
  const other = await restored.submit({ actor: { id: "owner" }, conversationId: "c2", text: "/kvcache" }).done;
  assert.match(String(other.result?.text), /暂无/);
});
