import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramProviderFixture as fixture } from "./fixtures/telegram-provider.js";
import { setTimeout as delay } from "node:timers/promises";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";
import { DeliveryRejected } from "../src/application/app-types.js";

test("a rejected current native draft still delivers the lasting literal Markdown final", async (t) => {
  let drafts = 0;
  const expected = "**结论**、[链接](https://example.com)\n\n```ts\nconst x = 1;\n```";
  const { f } = await fixture(t, async (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "**结论**" }, finish_reason: null }] })}\n\n`);
    await delay(300);
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: expected.slice("**结论**".length) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }, { createTransport: (api) => createTelegramRichTransport({ ...api, draftRich: async () => { drafts++; throw new DeliveryRejected("draft unavailable"); } }) });
  await f.send("reply"); assert.ok(drafts > 0); assert.deepEqual(f.sent.filter((text) => !text.startsWith("<details>")), [expected]);
  assert.ok((await f.rootLog.read()).some((e) => e.type === "delivery_succeeded"));
});

test("actual long plain streaming retains all content with native drafts and one durable settlement", async (t) => {
  const body = "流式正文abcdefgh😀".repeat(400); let generated = false; let live = false;
  const { f } = await fixture(t, async (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let at = 0; at < body.length; at += 80) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: body.slice(at, at + 80) }, finish_reason: null }] })}\n\n`); await delay(10);
    }
    generated = true; res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }, { createTransport: (api) => createTelegramRichTransport({ ...api, draftRich: async (id, chatId, text, signal) => { live ||= !generated; return api.draftRich(id, chatId, text, signal); } }) });
  await f.send("long text"); assert.ok(live);
  assert.equal(f.sent.filter((text) => !text.startsWith("<details>")).join("").replace(/\n/g, ""), body);
  const events = await f.rootLog.read();
  assert.equal(events.filter((e) => e.type === "text_finalized" && e.text === body).length, 1);
  assert.ok(!events.some((e) => e.type === "text_snapshot"));
  assert.equal(events.filter((e) => e.type === "delivery_succeeded").length, 1);
});
