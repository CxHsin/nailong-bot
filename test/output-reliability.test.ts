import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramProviderFixture as fixture } from "./fixtures/telegram-provider.js";
import { setTimeout as delay } from "node:timers/promises";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";

test("plain model text preserves multiline whitespace, escaping and JSON-shaped content in wire, drafts and durable final", async (t) => {
  const expected = '第一行\n第二行\r\n\t代码 C:\\temp、字面 \\n、引号 "、😀\n{"type":"final","text":"literal payload"}';
  const prefix = "第一行\n第二行"; let completed = false; let sawLive = false;
  let release!: () => void; const preview = new Promise<void>((resolve) => { release = resolve; });
  const { f, wire } = await fixture(t, async (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: prefix }, finish_reason: null }] })}\n\n`);
    await Promise.race([preview, delay(2000)]); completed = true;
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: expected.slice(prefix.length) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }, { createTransport: (api) => createTelegramRichTransport({ ...api, draftRich: async (id, chatId, text, signal) => {
    if (!completed && text.includes(prefix)) { sawLive = true; release(); }
    await api.draftRich(id, chatId, text, signal);
  } }) });
  await f.send("literal text");
  assert.ok(sawLive); assert.equal(wire.length, 1); assert.deepEqual(f.sent.filter((text) => !text.startsWith("<details>")), [expected]);
  const events = await f.rootLog.read();
  assert.ok(events.some((e) => e.type === "text_finalized" && e.text === expected));
  const model = events.find((e) => e.type === "model_message")?.message as { content: Array<{ type: string; text?: string }> };
  assert.equal(model.content.find((p) => p.type === "text")?.text, expected);
  assert.ok(!events.some((e) => e.type === "protocol_feedback" || e.type === "text_snapshot"));
});
