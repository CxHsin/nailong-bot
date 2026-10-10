import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { acceptanceOptions, acceptanceScenario, runTelegramAcceptance } from "../src/cli/telegram-acceptance.js";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";
import { planTelegramMarkdown } from "../src/telegram/telegram-markdown.js";

const identity = { mode: "source" as const, gitSha: "a".repeat(40), trackedDirty: false, builtAt: null };
test("acceptance previews without credentials and requires explicit owner destination for sending", () => {
  assert.deepEqual(acceptanceOptions([], {}), { mode: "preview" });
  assert.deepEqual(acceptanceOptions(["--help"], {}), { mode: "help" });
  const env = { AGENT_TELEGRAM_BOT_TOKEN: "PRIVATE TOKEN", AGENT_TELEGRAM_USER_ID: "42" };
  for (const args of [["--send"], ["--chat-id", "42"], ["--send", "--chat-id", "43"], ["--send", "--chat-id", "42", "extra"]])
    assert.throws(() => acceptanceOptions(args, env));
  assert.equal(acceptanceOptions(["--send", "--chat-id", "42"], env).mode, "send");
});

test("acceptance exercises actual projection append and settlement, leaving visual review pending", async () => {
  const sent: string[] = []; const drafts: string[] = [];
  const rich = createTelegramRichTransport({ sendRich: async (_chat, text) => { sent.push(text); return sent.length; },
    draftRich: async (_id, _chat, text) => { drafts.push(text); } });
  const report = await runTelegramAcceptance(rich, 42, identity, () => delay(3), 1);
  assert.equal(report.apiAcceptance, "passed"); assert.equal(report.visualAcceptance, "pending");
  const pages = planTelegramMarkdown(acceptanceScenario.finalText);
  assert.ok(pages.length > 1);
  assert.deepEqual(sent.slice(-pages.length), pages);
  assert.ok(sent.includes(acceptanceScenario.finding));
  assert.match(sent[0]!, /^<details><summary>运行状态<\/summary>/);
  assert.doesNotMatch(sent[0]!, /<details\s+open/);
  assert.ok(drafts.some((draft) => draft.startsWith("<details open><summary>运行状态</summary>")));
  assert.ok(drafts.includes(acceptanceScenario.finding));
  assert.ok(drafts.includes(acceptanceScenario.finalText));
  assert.ok(report.drafts.some((draft) => draft.segment === "finding" && draft.characters < acceptanceScenario.finding.length));
});

test("acceptance returns incomplete sanitized receipts on failed API delivery", async () => {
  const rich = createTelegramRichTransport({ sendRich: async () => { throw new Error("PRIVATE TOKEN URL"); }, draftRich: async () => {} });
  const report = await runTelegramAcceptance(rich, 42, identity, () => delay(1), 1);
  assert.equal(report.apiAcceptance, "incomplete"); assert.equal(report.visualAcceptance, "pending");
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|TOKEN URL/);
});
