import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bot } from "grammy";
import { Response as ApiResponse } from "node-fetch";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { initializeTelegramHostChannel } from "../src/channel/telegram/host-channel.js";
import { createTestServer } from "./fixtures/http-server.js";
import { diagnoseContext } from "../src/cli/context-diagnostics.js";

type WireMessage = { role: string; content?: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> };
type Quote = { nodeId: string; messageId: string; offset: number; end: number; text: string };
const quotes = (messages: WireMessage[]): Quote[] => messages.flatMap((message) => message.role === "user" && message.content?.startsWith("长期记忆原文引用") ? JSON.parse(message.content.slice(message.content.indexOf("\n") + 1)) : []);
const summary = "## Goal\n继续完成报告。\n## Progress\n已经读取资料一次，检查结果仍可从原始日志核查。\n## Constraints\n必须使用中文；提交前先验证；不要自动部署。\n## Decisions\n保留用户已经确认的方案。\n## Next Steps\n继续完成报告，未完成不能声称成功。\n## Critical Context\n" + "精确事实可从原始日志和 Akasha 恢复，旧技能加载仍有自己的正文与来源。".repeat(8);

test("Telegram continuous conversation combines append, skill versions, tools, compaction, memory and restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "continuous-acceptance-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  const root = join(dir, "skills", "demo"); await mkdir(root, { recursive: true });
  const path = join(root, "SKILL.md"); const body = "---\nname: demo\ndescription: Report workflow\n---\nSKILL-V1 use Chinese and preserve evidence";
  await writeFile(path, body); const resource = join(dir, "evidence.txt"); await writeFile(resource, "TOOL-EVIDENCE-EXACT");
  const wire: Array<{ model: string; messages: WireMessage[] }> = []; let summaries = 0; let dispatched = false;
  const server = createTestServer(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; const input = JSON.parse(raw);
    const summarizing = input.messages.some((message: WireMessage) => message.content?.includes("HISTORY_COMPACTION"));
    if (summarizing) summaries++; else wire.push(input);
    let delta: Record<string, unknown> = { content: summarizing ? summary : "继续执行已确认的报告" };
    if (!summarizing && !dispatched && raw.includes("TOOL_LOOP")) {
      dispatched = true; delta = { tool_calls: [{ index: 0, id: "evidence_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: resource }) } }] };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 50, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options = { dataDir: dir, promptFile, memoryBootstrap: false, skillSources: [{ name: "personal", path: join(dir, "skills") }],
    modelConfiguration: { defaultModel: "first", models: ["first", "second"].map((alias) => ({ alias, api: "openai-completions" as const,
      baseUrl: `http://127.0.0.1:${address.port}`, model: alias, apiKey: "test", contextWindow: 60000, maxTokens: 8192 })) } };
  let agent = await createPiAgent(options); const log = await createRuntimeEventLog(dir);
  let host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  let channel: Awaited<ReturnType<typeof initializeTelegramHostChannel>>;
  let bot: Bot; const replies: string[] = [];
  const connect = async () => {
    bot = new Bot("123:test", { client: { fetch: async (url) => new ApiResponse(JSON.stringify({ ok: true,
      result: String(url).endsWith("getMe") ? { id: 123, is_bot: true, first_name: "bot", username: "test_bot" } : true })) } });
    channel = await initializeTelegramHostChannel({ bot, ownerId: 42, host, transport: { send: async (text) => { replies.push(text); return replies.length; } },
      download: async () => { throw new Error("unused"); }, reportFailure: (error) => { throw error; },
      onDelivered: (event, telegramMessageId) => host.recordDelivery(event, { channel: "telegram", telegramMessageId }) });
  };
  await connect();
  t.after(async () => { await channel.finish(); await agent.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  let messageId = 0;
  const send = async (text: string) => {
    await bot.handleUpdate({ update_id: ++messageId, message: { message_id: messageId, date: 0,
      from: { id: 42, is_bot: false, first_name: "owner" }, chat: { id: 42, type: "private", first_name: "owner" }, text } });
    await channel.finish();
    const failed = (await log.read()).findLast((event) => event.type === "run_failed");
    assert.equal(failed, undefined, JSON.stringify(failed));
    return (await log.read()).findLast((event) => event.type === "message" && event.role === "user")!.requestId!;
  };
  const restart = async () => { await agent.close(); agent = await createPiAgent(options); host = createAgentHost({ dataDir: dir, promptFile, log, agent }); await connect(); };
  const originalText = "alpha_key original evidence " + "continuation ".repeat(250);
  const original = await send(originalText); const tiny = await send("tiny_key exact small evidence"); await send("/reset");
  await send("/demo 任务约束：使用中文、验证后提交、不部署。");
  await send("alpha_key tiny_key");
  const firstQuotes = quotes(wire.at(-1)!.messages);
  assert.ok(firstQuotes.some((quote) => quote.nodeId === original));
  const prefix = wire.at(-1)!.messages; await restart(); await send("alpha_key tiny_key again");
  assert.deepEqual(wire.at(-1)!.messages.slice(0, prefix.length), prefix);
  const restored = quotes(wire.at(-1)!.messages);
  assert.equal(restored.filter((quote) => quote.nodeId === tiny && quote.text === "tiny_key exact small evidence").length, 1);
  const intervals = restored.filter((quote) => quote.nodeId === original && quote.text.includes("continuation"));
  assert.ok(intervals.length > 1);
  for (const quote of intervals) assert.equal(quote.text, Array.from(originalText).slice(quote.offset, quote.end).join(""));
  for (let index = 1; index < intervals.length; index++) for (const prior of intervals.slice(0, index))
    assert.ok(intervals[index]!.offset >= prior.end || intervals[index]!.end <= prior.offset);
  for (const task of ["continue plan", "continue review"]) { const before = wire.at(-1)!.messages; await send(task); assert.deepEqual(wire.at(-1)!.messages.slice(0, before.length), before); }
  await send("/demo TOOL_LOOP 核查资料");
  assert.match(JSON.stringify(wire.at(-1)), /TOOL-EVIDENCE-EXACT/);
  const pairs = wire.at(-1)!.messages; assert.ok(pairs.some((message) => message.role === "assistant" && message.tool_calls?.some((call) => call.id === "evidence_read")));
  assert.ok(pairs.some((message) => message.role === "tool" && message.tool_call_id === "evidence_read"));
  await writeFile(path, body.replace("SKILL-V1", "SKILL-V2")); await restart(); await send("/demo use new instructions");
  assert.match(JSON.stringify(wire.at(-1)), /SKILL-V1/); assert.match(JSON.stringify(wire.at(-1)), /SKILL-V2/);
  for (const [index, size] of [70000, 40000, 40000, 40000].entries()) await send(`PRESSURE-${index} ` + String.fromCharCode(97 + index).repeat(size));
  assert.ok(summaries >= 2, `expected multiple compactions, saw ${summaries}`);
  assert.match(JSON.stringify(wire.at(-1)), /必须使用中文/);
  const summaryCount = summaries; await restart(); await send("after restart continue"); assert.equal(summaries, summaryCount);
  const exact = await send("alpha_key precise original evidence");
  assert.ok(quotes(wire.at(-1)!.messages).some((quote) => quote.nodeId === original));
  await send(`/forget ${original}`); await restart(); await send("alpha_key tiny_key after forget");
  assert.ok(!quotes(wire.at(-1)!.messages).some((quote) => quote.nodeId === original));
  await send("/model second"); await send("model switch preserves pending report"); assert.equal(wire.at(-1)!.model, "second");
  const facts = await log.read(); assert.equal(facts.filter((event) => event.type === "tool_dispatch" && event.toolName === "read").length, 1);
  const loaded = facts.filter((event) => event.type === "skill_loaded"); assert.equal(loaded[0]!.body, body); assert.match(String(loaded.at(-1)!.body), /SKILL-V2/);
  const diagnostic = await diagnoseContext({ dataDir: dir, conversationId: "telegram:private:42", requestId: exact });
  assert.equal(diagnostic.comparison.equal, true); assert.doesNotMatch(JSON.stringify(diagnostic), /SKILL-V|TOOL-EVIDENCE|alpha_key|continuation/);
  await send("/reset"); await send("fresh isolated task");
  const active = wire.at(-1)!.messages.filter((message) => !message.content?.startsWith("长期记忆原文引用"));
  assert.doesNotMatch(JSON.stringify(active), /历史摘要|SKILL-V1|SKILL-V2|TOOL-EVIDENCE-EXACT/);
});
