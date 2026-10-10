import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramProviderFixture as fixture, sendChatCompletion as output } from "./fixtures/telegram-provider.js";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";
import { DeliveryRejected } from "../src/application/app-types.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { conversationLog } from "../src/runtime/conversation-log.js";
import { projectDeliveredChat } from "../src/application/runtime-projections.js";

test("owner prompt configuration persists across restart without entering model history", async (t) => {
  const { f, wire } = await fixture(t, (res) => output(res, "answer"));
  await f.sendUpdate({ update_id: 1, message: { message_id: 1, date: 0, from: { id: 99, is_bot: false, first_name: "other" }, chat: { id: 99, type: "private", first_name: "other" }, text: "/prompt set forbidden-prompt" } });
  await f.send("/prompt set detailed-prompt"); await f.send("/prompt");
  assert.ok(f.sent.some((text) => text.includes("detailed-prompt")));
  assert.equal(wire.length, 0);
  await f.restart(); await f.send("question");
  assert.match(JSON.stringify(wire[0]), /detailed-prompt/);
  assert.doesNotMatch(JSON.stringify(wire[0]), /forbidden-prompt|\/prompt set/);
  await f.send("/prompt reset"); await f.send("another question");
  assert.doesNotMatch(JSON.stringify(wire[1]), /detailed-prompt|\/prompt/);
  assert.equal((await f.rootLog.read()).filter((e) => e.type === "bot_prompt_config").length, 2);
});

test("Provider failure produces a visible terminal failure without a settled answer", async (t) => {
  const { f, wire } = await fixture(t, (res) => { res.writeHead(400); res.end(JSON.stringify({ error: { message: "provider failed" } })); });
  await f.send("please answer");
  assert.equal(wire.length, 1);
  assert.ok(f.sent.some((text) => text.includes("处理失败")));
  const facts = await f.rootLog.read();
  assert.ok(facts.some((e) => e.type === "run_failed"));
  assert.ok(!facts.some((e) => e.type === "answer_generated" || e.type === "delivery_succeeded" || e.type === "memory_learned"));
});

test("definite final Telegram rejection retries three times without claiming unknown or successful delivery", async (t) => {
  let attempts = 0;
  const { f } = await fixture(t, (res) => output(res, "rejected-answer"), {
    createTransport: (api) => createTelegramRichTransport({ ...api, sendRich: async (chatId, text, signal) => {
      if (text === "rejected-answer") { attempts++; throw new DeliveryRejected("rejected"); }
      return api.sendRich(chatId, text, signal);
    } }),
  });
  await f.send("question");
  assert.equal(attempts, 3);
  const facts = await f.rootLog.read();
  assert.ok(facts.some((e) => e.type === "answer_generated" && e.text === "rejected-answer"));
  assert.equal(facts.filter((e) => e.type === "telegram_delivery_failed").length, 3);
  assert.ok(!facts.some((e) => e.type === "telegram_delivery_unknown" || e.type === "delivery_succeeded"));
});

test("partial final delivery retains page receipts and never resends an unknown page on restart", async (t) => {
  const body = "🐉".repeat(4100); let page = 0;
  const { f } = await fixture(t, (res) => output(res, body), {
    createTransport: (api) => createTelegramRichTransport({ ...api, sendRich: async (chatId, text, signal) => {
      if (text.includes("🐉") && ++page === 2) throw new Error("connection lost after send");
      return api.sendRich(chatId, text, signal);
    } }),
  });
  await f.send("long answer");
  const facts = await f.rootLog.read();
  assert.equal(facts.filter((e) => e.type === "telegram_delivery_succeeded" && e.partIndex === 0).length, 1);
  assert.equal(facts.filter((e) => e.type === "telegram_delivery_unknown" && e.partIndex === 1).length, 1);
  assert.ok(!facts.some((e) => e.type === "delivery_succeeded"));
  assert.equal(page, 2); await f.restart(); assert.equal(page, 2);
});

test("actual legacy message-only JSONL stays readable without acquiring a current Conversation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "legacy-message-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = [
    { type: "message", role: "user", text: "old user", at: "2026-01-01T00:00:00Z" },
    { type: "message", role: "assistant", text: "old reply", at: "2026-01-01T00:00:01Z" },
  ];
  const source = original.map((event) => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(join(dir, "events.jsonl"), source);
  const log = await createRuntimeEventLog(dir);
  const imported = await log.read();
  assert.deepEqual(imported.filter((e) => e.type === "message").map((e) => ({ type: e.type, role: e.role, text: e.text, at: e.at })), original);
  assert.deepEqual(projectDeliveredChat(imported), [{ role: "user", text: "old user" }, { role: "assistant", text: "old reply" }]);
  assert.ok(imported.filter((e) => e.type === "message").every((e) => e.conversationId === undefined && e.chatId === undefined));
  assert.deepEqual(await conversationLog(log, "telegram:private:42").read(), []);
  const reopened = await createRuntimeEventLog(dir);
  assert.deepEqual(await reopened.read(), imported);
  assert.equal(await readFile(join(dir, "events.jsonl"), "utf8"), source);
});
