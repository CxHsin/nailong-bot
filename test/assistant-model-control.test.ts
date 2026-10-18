import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

const conversationId = "telegram:private:42";
const catalog = [
  { id: "vendor/deep/A", display_name: "A", reasoning: true, supported_reasoning_levels: ["low", "medium", "high"] },
  { id: "route/group/C", display_name: "C", reasoning: true, supported_reasoning_levels: ["low", "high"] },
];

test("unselected first inputs persist across reopen and selecting a model releases their original FIFO", async () => {
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => { requests.push(wire); sendChatCompletion(response, "done"); }, undefined,
    { catalog, selectedModel: null, primaryConversationId: conversationId });
  try {
    await f.app.receive({ conversationId, inputId: "first", text: "FIRST_GOAL" });
    await f.app.waitForIdle();
    assert.equal(requests.length, 0);
    await f.reopen();
    await f.app.receive({ conversationId, inputId: "second", text: "SECOND_GOAL" });
    await f.app.waitForIdle();
    const waiting = await f.app.controlSnapshot(conversationId);
    assert.equal(waiting.status, "waiting_model");
    assert.equal(waiting.waiting, 2);
    await f.app.control(conversationId, { type: "model", model: "vendor/deep/A" });
    await f.app.waitForIdle();
    assert.equal(requests.length, 1);
    const text = JSON.stringify(requests[0]!.messages);
    assert.ok(text.indexOf("FIRST_GOAL") < text.indexOf("SECOND_GOAL"));
    assert.equal((requests[0] as Wire & {model:string}).model, "vendor/deep/A");
    assert.equal((requests[0] as Wire & {reasoning_effort:string}).reasoning_effort, "medium");
  } finally { await f.close(); }
});
