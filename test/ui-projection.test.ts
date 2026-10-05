import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createTelegramHostProjection } from "../src/channel/telegram/index.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import type { HostEvent } from "../src/host/host.js";
import { memoryNodes } from "../src/runtime/memory-facts.js";

test("production Pi progress reaches Telegram and stage results survive final delivery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ui-projection-"));
  const promptFile = join(dir, "prompt.md");
  await writeFile(promptFile, "用中文回答。");
  let calls = 0;
  const inputs: Array<Array<{ role: string; content: unknown }>> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    inputs.push(JSON.parse(body).messages);
    const step = calls++;
    const delta = step === 0 ? {
      content: JSON.stringify({ type: "status", text: "先检查目录，再确认文件是否存在。" }),
      tool_calls: [{ index: 0, id: "list-files", type: "function", function: { name: "ls", arguments: '{"path":"."}' } }],
    } : { content: JSON.stringify(step === 1 ? { type: "result", text: "目录中有 prompt.md。" } : { type: "final", text: "检查完成。" }) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "ui-test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    res.end(`data: ${JSON.stringify({ id: "ui-test", choices: [{ index: 0, delta: {}, finish_reason: step === 0 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false });
  t.after(async () => {
    await agent.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const log = createRuntimeLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const drafts: string[] = [];
  const sent: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42, draftIntervalMs: 5,
    draft: async (_id, text) => { drafts.push(text); },
    send: async (text) => { sent.push(text); return 7; },
    onDelivered: (event, telegramMessageId) => host.recordDelivery(event, { channel: "telegram", telegramMessageId }),
  });
  const run = host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "检查目录" });
  const observed: HostEvent[] = [];
  await projection.consume({ ...run, events: async function* () {
    for await (const event of run.events()) { observed.push(event); yield event; }
  } });
  assert.ok(drafts.some((text) => text.includes("先检查目录")), JSON.stringify(drafts));
  assert.deepEqual(sent, ["目录中有 prompt.md。\n\n检查完成。"]);
  assert.equal(calls, 3);
  assert.deepEqual(observed.flatMap((event) => event.progress?.type === "tool" ? [event.progress.state] : []), ["started", "completed"]);
  assert.ok(inputs.every((messages) => !messages.some((message) => JSON.stringify(message.content).includes("正在调用"))));
  const events = await log.read();
  assert.ok(events.some((event) => event.type === "tool_dispatch" && event.toolName === "ls"));
  assert.ok(events.some((event) => event.type === "delivery_succeeded"));
  assert.equal(events.some((event) => event.type === "progress" || event.type === "progress_event"), false);
  assert.equal(events.some((event) => event.type === "text_snapshot" && event.provisional), false);
  assert.deepEqual(memoryNodes(events, 42)[0]?.messages.filter((message) => message.role === "assistant").map((message) => message.text),
    ["目录中有 prompt.md。", "检查完成。"]);
  await projection.consume(host.submit({ actor: { id: "owner" }, conversationId: "telegram:private:42", text: "接着回答" }));
  assert.equal(calls, 4);
  const nextInput = JSON.stringify(inputs.at(-1));
  assert.doesNotMatch(nextInput, /先检查目录|正在调用|已完成：/);
  assert.match(nextInput, /目录中有 prompt.md/);
  assert.equal(nextInput.match(/目录中有 prompt.md/g)?.length, 1);
});
