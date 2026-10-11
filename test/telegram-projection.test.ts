import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramProviderFixture as fixture, sendChatCompletion as output, checkWrites as guard } from "./fixtures/telegram-provider.js";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";
import { DeliveryRejected } from "../src/application/app-types.js";

import { deliverContent } from "../src/runtime/content-delivery.js";
import { planTelegramMarkdown } from "../src/telegram/telegram-markdown.js";

test("API success followed by a durable page receipt commit failure remains storage failure and never resends", async (t) => {
  let fail = true; let attempts = 0;
  const { f } = await fixture(t, (res) => output(res, "committed-answer"), {
    wrapLog: (log) => guard(log, (e) => { if (fail && e.type === "telegram_delivery_succeeded") throw new Error("SQLite commit failed"); }),
    createTransport: (api) => createTelegramRichTransport({ ...api, sendRich: async (chatId, text, signal) => { if (text === "committed-answer") attempts++; return api.sendRich(chatId, text, signal); } }),
  });
  await f.send("question"); assert.equal(attempts, 1);
  assert.ok(f.failures.some((e) => String(e).includes("SQLite commit failed")));
  const facts = await f.rootLog.read(); const final = facts.find((e) => e.type === "text_finalized" && e.text === "committed-answer");
  assert.ok(final && typeof final.requestId === "string" && typeof final.textSegmentId === "string");
  assert.equal(facts.filter((e) => e.type === "telegram_delivery_attempt").length, 1);
  assert.ok(!facts.some((e) => e.type === "telegram_delivery_unknown" || e.type === "delivery_succeeded"));
  fail = false; await f.restart(); assert.equal(attempts, 1);
  const result = await deliverContent(f.scopedLog, final.requestId, 42, { id: final.textSegmentId, text: "committed-answer", kind: "final" }, { send: async () => { attempts++; return 999; } });
  assert.equal(result.outcome, "unknown"); assert.equal(attempts, 1);
});

test("current immutable Rich plan preserves long code, Unicode, tables, links and list content with durable page order", async (t) => {
  const emoji = "👨‍👩‍👧‍👦";
  const body = "### 内容\n\n" + emoji.repeat(600) + "\n\n1. 第一项\n2. 第二项\n\n[来源](https://example.com?a=1&b=2)\n\n| 名称 | 值 |\n| --- | --- |\n| 中文 | A&B<值> |\n\n```text\n" + "<&>".repeat(1800) + "\n```\n\n尾部结论。";
  const expected = planTelegramMarkdown(body); const { f } = await fixture(t, (res) => output(res, body));
  await f.send("mixed answer"); assert.deepEqual(f.sent.filter((text) => !text.startsWith("<details>")), expected);
  const joined = f.sent.filter((text) => !text.startsWith("<details>")).join(""); assert.equal(joined.split(emoji).length - 1, 600);
  const code = Array.from(joined.matchAll(/```text\n([\s\S]*?)\n```/g), (match) => match[1]).join("");
  assert.equal(code, "<&>".repeat(1800));
  for (const text of ["第一项", "第二项", "来源", "A&B<值>", "尾部结论"]) assert.ok(joined.includes(text));
  assert.ok(f.sent.every((page) => page.length <= 4096 && !page.startsWith("\u200d") && !page.endsWith("\u200d")));
  const facts = await f.rootLog.read(); const pages = facts.filter((e) => e.type === "telegram_page" && e.contentKind === "final");
  assert.deepEqual(pages.map((e) => e.text), expected); assert.deepEqual(pages.map((e) => e.partIndex), expected.map((_, i) => i));
  assert.equal(facts.filter((e) => e.type === "telegram_delivery_succeeded").length, expected.length);
  assert.ok(facts.some((e) => e.type === "delivery_succeeded"));
  const immutable = structuredClone(pages); await f.restart(); assert.deepEqual((await f.rootLog.read()).filter((e) => e.type === "telegram_page" && e.contentKind === "final"), immutable);
});

test("known Rich rejection honors retry-after on the same page and commits one successful receipt", async (t) => {
  let rejectedAt = 0; let retriedAt = 0; let attempts = 0;
  const { f } = await fixture(t, (res) => output(res, "limited-answer"), { createTransport: (api) => createTelegramRichTransport({ ...api, sendRich: async (chatId, text, signal) => {
    if (text === "limited-answer") { if (++attempts === 1) { rejectedAt = Date.now(); throw new DeliveryRejected("rate limited", 150); } retriedAt = Date.now(); }
    return api.sendRich(chatId, text, signal);
  } }) });
  await f.send("rate limit"); assert.equal(attempts, 2); assert.ok(retriedAt - rejectedAt >= 150);
  assert.equal(f.sent.filter((text) => text === "limited-answer").length, 1);
  const facts = await f.rootLog.read(); assert.equal(facts.filter((e) => e.type === "telegram_delivery_failed").length, 1);
  assert.equal(facts.filter((e) => e.type === "telegram_delivery_succeeded").length, 1);
  assert.ok(!facts.some((e) => e.type === "telegram_delivery_unknown"));
});

test("native nested quote pagination retains all nested text and Unicode within page bounds", () => {
  const repeated = "长引用内容😀";
  const body = "> 外层引用\n>\n> > 内层 **加粗**\n> >\n> > - 列表中的引用\n> >   > 更深层内容\n> >\n> > " + repeated.repeat(1200);
  const pages = planTelegramMarkdown(body);
  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.length <= 3500 && !/[\uD800-\uDBFF]$/.test(page)));
  const joined = pages.join("");
  for (const text of ["外层引用", "内层 **加粗**", "列表中的引用", "更深层内容"]) assert.ok(joined.includes(text));
  assert.equal(joined.match(/长引用内容😀/g)?.length, 1200);
});
