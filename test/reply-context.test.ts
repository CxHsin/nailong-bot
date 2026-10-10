import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import { Response as FetchResponse } from "node-fetch";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { initializeTelegramHostChannel } from "../src/channel/telegram/host-channel.js";
import { normalizeTelegramInput } from "../src/channel/telegram/index.js";
import { closeFixture } from "./fixtures/cleanup.js";

test("Telegram reply to a delivered KV report reaches Provider, survives a tool step and respects forgetting", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reply-context-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  const seen: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); seen.push(payload);
    const last = payload.messages.at(-1);
    const useTool = last.role === "user" && last.content.includes("这数据似乎并不是实时的？");
    const delta = useTool ? { tool_calls: [{ index: 0, id: "inspect", type: "function", function: { name: "read", arguments: JSON.stringify({ path: promptFile }) } }] } :
      { content: "收到" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: useTool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const bot = new Bot("123:test", { client: { fetch: async (url) => new FetchResponse(JSON.stringify({ ok: true,
    result: String(url).endsWith("getMe") ? { id: 123, is_bot: true, first_name: "bot", username: "test_bot" } : true })) } });
  const sent: string[] = [];
  const channel = await initializeTelegramHostChannel({ bot, ownerId: 42, host,
    transport: { send: async (text) => { sent.push(text); return 9000 + sent.length; } },
    download: async () => { throw new Error("unused"); }, reportFailure: (error) => { throw error; },
    onDelivered: (event, telegramMessageId) => host.recordDelivery(event, { channel: "telegram", telegramMessageId }) });
  let updateId = 0;
  const send = async (text: string, replyId?: number) => {
    const chat = { id: 42, type: "private" as const, first_name: "owner" };
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 0, text, chat,
      from: { id: 42, is_bot: false, first_name: "owner" },
      ...(replyId ? { reply_to_message: { message_id: replyId, date: 0, chat, text: "客户端片段不是可信来源", reply_to_message: undefined } } : {}) } });
    await channel.finish();
  };
  await send("/kvcache"); assert.equal(seen.length, 0);
  await send("你好"); assert.doesNotMatch(JSON.stringify(seen.at(-1)!.messages), /奶龙赛博反刍胃囊报表/);
  await send("这数据似乎并不是实时的？", 9001);
  assert.match(JSON.stringify(seen.at(-2)!.messages), /奶龙赛博反刍胃囊报表/);
  assert.match(JSON.stringify(seen.at(-1)!.messages), /奶龙赛博反刍胃囊报表/);
  assert.doesNotMatch(JSON.stringify(seen.at(-1)!.messages), /客户端片段不是可信来源/);
  const events = await log.read();
  const question = events.find((e) => e.type === "message" && e.originalText === "这数据似乎并不是实时的？")!;
  assert.equal(question.text, "这数据似乎并不是实时的？");
  assert.equal(question.replyToMessageId, 9001);
  const reportRun = events.find((e) => e.type === "run_succeeded" && (e.result as { cache?: unknown })?.cache)!.runId;
  await log.append({ type: "memory_excluded", nodeId: reportRun, conversationId: "telegram:private:42" });
  await send("继续"); assert.doesNotMatch(JSON.stringify(seen.at(-1)!.messages), /奶龙赛博反刍胃囊报表/);
  assert.match(sent[0]!, /奶龙赛博反刍胃囊报表/);
});

test("reply resolution excludes foreign, undelivered, unknown and non-cache control reports", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reply-isolation-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir); const histories: string[] = [];
  const host = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log, agent: {
    answer: async (messages) => { histories.push(JSON.stringify(messages)); return "answer"; },
  } });
  const control = await host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "/kvcache" }).done;
  await host.recordDelivery(control, { channel: "telegram", telegramMessageId: 100 });
  const undelivered = await host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "/kvcache" }).done;
  const help = await host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "/help" }).done;
  await host.recordDelivery(help, { channel: "telegram", telegramMessageId: 101 });
  for (const [owner, reply] of [[99, 100], [42, 999], [42, 101]]) {
    await host.submit(normalizeTelegramInput({ fromId: owner!, chatId: owner!, chatType: "private", messageId: reply!, replyToMessageId: reply, text: "这数据" })).done;
    assert.doesNotMatch(histories.at(-1)!, /奶龙赛博反刍胃囊报表|查看命令帮助/);
  }
  assert.equal((await log.read()).some((e) => e.type === "delivery_succeeded" && e.runId === undelivered.runId), false);
});
