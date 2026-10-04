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
import { parseStructuredText, readOutputFrames } from "../src/agent/output-protocol.js";
import { closeFixture } from "./fixtures/cleanup.js";

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
