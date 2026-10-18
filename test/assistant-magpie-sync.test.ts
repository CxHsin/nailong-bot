import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

const primary = "telegram:private:42";
const models = [
  { id: "provider/team/A", reasoning: true, supported_reasoning_levels: ["low", "medium", "high"] },
  { id: "route/group/B", reasoning: false },
  { id: "provider/C", reasoning: true, supported_reasoning_levels: ["low", "high"] },
];

test("explicit Magpie and Telegram changes win in order while refresh, echoes and restart preserve independent conversations", async () => {
  const requests: Array<Wire & { model: string }> = [];
  const f = await assistantFixture((wire, response) => { requests.push(wire as Wire & { model: string }); sendChatCompletion(response, "sync answer"); }, undefined,
    { catalog: models, selectedModel: models[0]!.id, primaryConversationId: primary });
  try {
    assert.equal((await f.app.controlSnapshot(primary)).selectedModel, "provider/team/A");
    await f.app.control("cli:independent", { type: "model", model: "route/group/B" });
    await f.writeMagpie({ unrelated: { keep: 73 }, model: "magpie/provider/C" });
    assert.equal((await f.app.controlSnapshot(primary)).selectedModel, "provider/C");
    assert.equal((await f.app.controlSnapshot("cli:independent")).selectedModel, "route/group/B");

    await f.app.receive({ conversationId: primary, inputId: "telegram-selection", text: "/model provider/team/A" });
    await f.app.waitForIdle();
    const written = JSON.parse(await readFile(f.magpieConfigPath, "utf8"));
    assert.equal(written.model, "magpie/provider/team/A");
    assert.deepEqual(written.unrelated, { keep: 73 });
    await f.writeMagpie({ anotherWriter: "newer unrelated field" });
    await f.app.controlSnapshot(primary, { refresh: true });
    await f.reopen();
    assert.equal((await f.app.controlSnapshot(primary)).selectedModel, "provider/team/A");
    assert.equal((await f.app.controlSnapshot("cli:independent")).selectedModel, "route/group/B");
    assert.equal(requests.length, 0, "synchronization and restarting must not generate work");

    await f.app.receive({ conversationId: primary, inputId: "main-goal", text: "MAIN_GOAL" });
    await f.app.receive({ conversationId: "cli:independent", inputId: "cli-goal", text: "CLI_GOAL" });
    await f.app.waitForIdle();
    assert.deepEqual(requests.map(request => request.model).sort(), ["provider/team/A", "route/group/B"]);
  } finally { await f.close(); }
});

test("switching to a smaller catalog window uses native compaction and retains the same goal across reopen", { timeout: 30000 }, async () => {
  let summaries = 0;
  const requests: Array<Wire & { model: string }> = [];
  const f = await assistantFixture((wire, response) => {
    if (JSON.stringify(wire.messages[0]).includes("context summarization assistant")) {
      summaries++;
      sendChatCompletion(response, "## Goal\nContinue ORIGINAL_GARDEN_GOAL.\n## Progress\nSelected lotus; confirmed garden plan.\n## Next Steps\nContinue watering.");
    } else { requests.push(wire as typeof requests[number]); sendChatCompletion(response, "garden acknowledged"); }
  }, async () => ({ compaction: { reserveTokens: 1500, keepRecentTokens: 600, backgroundTokens: 0 } }), {
    catalog: [...models, { id: "small/window", context_window: 7000, max_output_tokens: 1024, reasoning: false }],
    selectedModel: models[0]!.id, primaryConversationId: primary,
  });
  try {
    for (let index = 0; index < 4; index++) {
      await f.app.receive({ conversationId: primary, inputId: `garden-${index}`, text: `ORIGINAL_GARDEN_GOAL ${index}: ` + "garden material ".repeat(300) });
      await f.app.waitForIdle();
    }
    const count = requests.length;
    await f.app.control(primary, { type: "model", model: "small/window" });
    assert.equal(requests.length, count, "selecting a smaller model does not generate work or reset context");
    await f.app.receive({ conversationId: primary, inputId: "smaller", text: "CONTINUE_WATERING" });
    await f.app.waitForIdle();
    assert.ok(summaries > 0, "the real native summarizer must run after selecting a smaller context window");
    assert.equal(requests.at(-1)!.model, "small/window");
    assert.match(JSON.stringify(requests.at(-1)!.messages), /ORIGINAL_GARDEN_GOAL/);
    assert.match(JSON.stringify(requests.at(-1)!.messages), /CONTINUE_WATERING/);
    await f.reopen();
    await f.app.receive({ conversationId: primary, inputId: "after-reopen", text: "keep watering" });
    await f.app.waitForIdle();
    assert.match(JSON.stringify(requests.at(-1)!.messages), /ORIGINAL_GARDEN_GOAL/);
  } finally { await f.close(); }
});

test("an incomplete connection edit retains preferences and work until valid configuration is restored", async () => {
  const requests: Wire[] = [];
  const failures: unknown[] = [];
  const f = await assistantFixture((wire, response) => { requests.push(wire); sendChatCompletion(response, "restored answer"); }, async () => ({ reportFailure: error => failures.push(error) }),
    { catalog: models, selectedModel: models[0]!.id, primaryConversationId: primary });
  try {
    await f.app.control(primary, { type: "thinking", level: "high" });
    const valid = await readFile(f.magpieConfigPath, "utf8");
    await writeFile(f.magpieConfigPath, '{"baseUrl":');
    const invalid = await f.app.controlSnapshot(primary);
    assert.equal(invalid.connected, false);
    assert.match(invalid.connectionError ?? "", /配置/);
    assert.equal(invalid.selectedModel, "provider/team/A");
    assert.equal(invalid.thinking, "high");
    await f.app.receive({ conversationId: primary, inputId: "during-edit", text: "PRESERVED_GOAL" });
    await f.app.waitForIdle();
    assert.equal(requests.length, 0);
    await writeFile(f.magpieConfigPath, valid);
    await f.app.controlSnapshot(primary);
    await f.app.waitForIdle();
    assert.equal(requests.length, 1);
    assert.match(JSON.stringify(requests[0]!.messages), /PRESERVED_GOAL/);
    assert.equal((requests[0] as Wire & { reasoning_effort: string }).reasoning_effort, "high");
    assert.deepEqual(failures, []);
  } finally { await f.close(); }
});
