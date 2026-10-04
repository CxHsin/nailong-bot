import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { createTelegramHostProjection } from "../src/channel/telegram/index.js";
import { parseStructuredText, readOutputFrames, recoverFinalEnvelope } from "../src/agent/output-protocol.js";
import { closeFixture } from "./fixtures/cleanup.js";

test("a normally stopped final with only a missing closing envelope reaches Telegram without retry exhaustion", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unclosed-final-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  const expected = "没有得奖不代表你的努力没有价值。\n\n如果愿意，我们可以聊聊这次经历。";
  const raw = JSON.stringify({ type: "final", text: expected }).slice(0, -2);
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: raw }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = createRuntimeLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const sent: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42, send: async (text) => { sent.push(text); return 1; } });
  const run = host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "比赛结束了，我没有得奖。" });
  await projection.consume(run);
  assert.equal((await run.done).type, "run_succeeded", JSON.stringify(sent));
  assert.deepEqual(sent, [expected]);
  assert.equal(calls, 1);
  const events = await log.read();
  assert.equal(events.some((event) => event.type === "protocol_feedback"), false);
  assert.ok(events.some((event) => event.type === "protocol_validated" && event.repairedEnvelope === true));
  const original = events.find((event) => event.type === "model_message")!.message as { content: Array<{ type: string; text?: string }> };
  assert.equal(original.content[0]!.text, raw);
});

test("raw whitespace in model JSON strings reaches Telegram without retries and preserves the raw record", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-reliability-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  const raw = '{"type":"final","text":"结论如下。\n\n```ts\nconst x = 1;\r\n\tconsole.log(x);\n```"}';
  const expected = "结论如下。\n\n```ts\nconst x = 1;\r\n\tconsole.log(x);\n```";
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: raw }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = createRuntimeLog(dir);
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const sent: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42, send: async (text) => { sent.push(text); return 1; } });
  const run = host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "分析" });
  await projection.consume(run);
  assert.equal((await run.done).type, "run_succeeded");
  assert.deepEqual(sent, [expected]);
  assert.equal(calls, 1);
  const events = await log.read();
  assert.equal(events.some((e) => e.type === "protocol_feedback"), false);
  assert.ok(events.some((e) => e.type === "protocol_validated" && e.normalizedWhitespace === true));
  const original = events.find((e) => e.type === "model_message")!.message as { content: Array<{ type: string; text?: string }> };
  assert.equal(original.content[0]!.text, raw);
});

test("whitespace normalization preserves frame boundaries, escapes and structural rejection", () => {
  const raw = '{"type":"final","text":"甲\n","end":false}\n{"type":"final","text":"乙\t丙","end":true}';
  assert.equal(parseStructuredText(raw).text, "甲\n乙\t丙");
  assert.equal(readOutputFrames(raw.slice(0, raw.indexOf("\n{") + 1)).prefix?.text, "甲\n");
  assert.equal(parseStructuredText(JSON.stringify({ type: "final", text: '引号"，路径 C:\\test，字面 \\n' })).text, '引号"，路径 C:\\test，字面 \\n');
  for (const invalid of [
    '{"type":"final","text":"甲\n乙"',
    '{"type":"final","text":"甲\n乙","extra":true}',
    '{"type":"final","text":"甲\n乙","end":false}',
    '{"type":"final","text":"甲\u0000乙"}',
    '{"type":"final","text":"甲\\\n乙"}',
    '{"type":"final","text":"甲\n乙"}\n{"type":"final","text":"丙"}',
  ]) assert.throws(() => parseStructuredText(invalid));
});

test("final envelope recovery preserves text and refuses truncation, tool calls and other malformed structure", () => {
  const text = '中文\n代码：C:\\temp；引号 "；括号 }；字面 \\n';
  const valid = JSON.stringify({ type: "final", text });
  for (const count of [1, 2]) assert.deepEqual(recoverFinalEnvelope(valid.slice(0, -count), "stop", false), { type: "final", text });
  const literalWhitespace = '{"type":"final","text":"甲\n\t乙';
  assert.deepEqual(recoverFinalEnvelope(literalWhitespace, "stop", false), { type: "final", text: "甲\n\t乙" });
  for (const reason of ["length", "error", "aborted", "toolUse"]) assert.equal(recoverFinalEnvelope(valid.slice(0, -2), reason, false), undefined);
  assert.equal(recoverFinalEnvelope(valid.slice(0, -2), "stop", true), undefined);
  for (const raw of [
    valid,
    '{"type":"status","text":"状态',
    '{"type":"result","text":"成果',
    '{"type":"final","text":"尾部转义\\',
    '{"type":"final","text":"不完整 Unicode\\u12',
    '{"type":"final","text":"正文","extra":true',
    '{"type":"final","text":"正文","end":false}',
    '{"type":"final","text":"正文","end":true',
    '{"type":"final","text":"正文"}\n{"type":"final","text":"追加',
    '{"type":"final","text":"裸引号"正文',
  ]) assert.equal(recoverFinalEnvelope(raw, "stop", false), undefined, raw);
});
