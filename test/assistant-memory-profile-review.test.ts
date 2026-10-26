import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

test("maintenance budgets global and project profiles together when both are visible to one request", { timeout: 60_000 }, async () => {
  let phase = "global"; let project = ""; let receipt = "";
  const f = await assistantFixture((wire, response) => {
    if (wire.messages.at(-1)?.role !== "tool") {
      const name = phase === "inspect" ? "memory_search" : "memory_write";
      const args = phase === "inspect" ? { query: "quota" } : {
        action: "add", kind: "MEMORY", content: `quota ${phase} ` + "retained detail ".repeat(220),
        quote: `quota original ${phase}`, expectedVersion: phase === "global" ? 0 : 1,
        ...(phase === "project" ? { project } : {}),
      };
      return sendChatCompletion(response, "", [{ index: 0, id: phase, type: "function", function: { name, arguments: JSON.stringify(args) } }]);
    }
    receipt = String(wire.messages.at(-1)?.content); sendChatCompletion(response, "已处理");
  }, async cwd => { project = cwd; return { memory: { residentBytes: 8000 }, reportFailure() {} }; });
  try {
    await f.app.receive({ conversationId: "one", inputId: "global", text: "quota original global" }); await f.app.waitForIdle(); assert.doesNotMatch(receipt, /\[error\]/);
    phase = "project"; await f.app.receive({ conversationId: "one", inputId: "project", text: "quota original project" }); await f.app.waitForIdle(); assert.doesNotMatch(receipt, /\[error\]/);
    await new Promise(resolve => setTimeout(resolve, 1200)); await f.reopen(); phase = "inspect";
    await f.app.receive({ conversationId: "one", inputId: "inspect", text: "查询quota档案和原始依据" }); await f.app.waitForIdle();
    const result = JSON.parse(receipt);
    assert.ok(result.memories.length < 2, "the combined resident set must be maintained even though each scope separately fits");
    assert.match(receipt, /quota original global/); assert.match(receipt, /quota original project/);
  } finally { await f.close(); }
});
