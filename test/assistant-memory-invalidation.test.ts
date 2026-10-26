import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function call(response: Parameters<typeof sendChatCompletion>[0], name: string, args: object, id: string) {
  sendChatCompletion(response, "", [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]);
}
function lastTool(wire: Wire) { return String(wire.messages.filter((message) => message.role === "tool").at(-1)?.content ?? ""); }

test("forgetting an original excludes its assistant paraphrases from automatic recall after reset and restart", { timeout: 60_000 }, async () => {
  let phase = "seed"; let sourceId = ""; const requests: string[] = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(JSON.stringify(wire.messages));
    if (phase === "seed") {
      sourceId = requests.at(-1)!.match(/sourceId=(source:[a-f0-9]{64})/)?.[1] ?? sourceId;
      return sendChatCompletion(response, "派生画像：早餐饮品选择 Golden infusion，属于长期习惯。");
    }
    if (phase === "forget" && wire.messages.at(-1)?.role !== "tool") return call(response, "memory_forget", { id: sourceId, expectedVersion: 0 }, "forget-origin");
    sendChatCompletion(response, "已处理");
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "seed", text: "早餐长期喝琥珀花茶，请记下这段原始资料" }); await f.app.waitForIdle(); assert.ok(sourceId);
    phase = "forget"; await f.app.receive({ conversationId: "one", inputId: "forget", text: "忘记刚才的饮品习惯" }); await f.app.waitForIdle();
    assert.doesNotMatch(requests.at(-1)!, /派生画像|属于长期习惯/);
    await f.app.receive({ conversationId: "one", inputId: "reset", text: "/reset" }); await f.app.waitForIdle(); await f.reopen();
    phase = "ask"; await f.app.receive({ conversationId: "one", inputId: "ask", text: "查找 Golden infusion 的历史背景" }); await f.app.waitForIdle();
    assert.doesNotMatch(requests.at(-1)!, /派生画像|属于长期习惯/);
  } finally { await f.close(); }
});

test("shared forgetting invalidates a previously appended change without a local forget receipt", { timeout: 60_000 }, async () => {
  let phase = "warm"; let sourceId = ""; const readerRequests: string[] = [];
  const f = await assistantFixture((wire, response) => {
    const request = JSON.stringify(wire.messages);
    if (phase.startsWith("reader")) readerRequests.push(request);
    if (phase === "remember" && wire.messages.at(-1)?.role !== "tool") {
      sourceId = request.match(/sourceId=(source:[a-f0-9]{64})/)?.[1] ?? "";
      return call(response, "memory_write", { action: "add", kind: "MEMORY", content: "共享画像：偏好铜铃花", quote: "我偏好铜铃花", expectedVersion: 0 }, "shared-memory");
    }
    if (phase === "forget" && wire.messages.at(-1)?.role !== "tool") return call(response, "memory_forget", { id: sourceId, expectedVersion: 1 }, "forget-shared");
    sendChatCompletion(response, "完成本轮");
  });
  try {
    await f.app.receive({ conversationId: "reader", inputId: "warm", text: "开始独立工作" }); await f.app.waitForIdle();
    phase = "remember"; await f.app.receive({ conversationId: "writer", inputId: "remember", text: "记住我偏好铜铃花" }); await f.app.waitForIdle(); assert.ok(sourceId);
    phase = "reader-before"; await f.app.receive({ conversationId: "reader", inputId: "before", text: "继续已有工作" }); await f.app.waitForIdle();
    assert.match(readerRequests.at(-1)!, /共享画像：偏好铜铃花/);
    phase = "forget"; await f.app.receive({ conversationId: "writer", inputId: "forget", text: "忘记刚才的花卉偏好" }); await f.app.waitForIdle();
    phase = "reader-after"; await f.app.receive({ conversationId: "reader", inputId: "after", text: "继续独立任务" }); await f.app.waitForIdle();
    assert.doesNotMatch(readerRequests.at(-1)!, /共享画像：偏好铜铃花/);
  } finally { await f.close(); }
});

test("a superseded original cannot be learned as a new memory through a later write", { timeout: 60_000 }, async () => {
  let phase = "seed"; let sourceId = ""; let targetId = ""; let retryResult = "";
  const f = await assistantFixture((wire, response) => {
    if (wire.messages.at(-1)?.role !== "tool") {
      if (phase === "seed") {
        sourceId = JSON.stringify(wire.messages).match(/sourceId=(source:[a-f0-9]{64})/)?.[1] ?? "";
        return call(response, "memory_write", { action: "add", kind: "MEMORY", content: "旧偏好：浓咖啡", quote: "我喜欢浓咖啡", sourceId, expectedVersion: 0 }, "seed-memory");
      }
      if (phase === "correct") return call(response, "memory_write", { action: "supersede", kind: "MEMORY", content: "当前偏好：白开水", quote: "现在只喝白开水", targetId, expectedVersion: 1 }, "correct-memory");
      return call(response, "memory_write", { action: "add", kind: "MEMORY", content: "被重新学习的旧偏好：浓咖啡", quote: "我喜欢浓咖啡", sourceId, expectedVersion: 2 }, "relearn-retired");
    }
    if (phase === "seed") targetId = lastTool(wire).match(/memory:[a-f0-9-]{36}/)?.[0] ?? "";
    if (phase === "retry") retryResult = lastTool(wire);
    sendChatCompletion(response, "已处理");
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "seed", text: "记住我喜欢浓咖啡" }); await f.app.waitForIdle(); assert.ok(targetId);
    phase = "correct"; await f.app.receive({ conversationId: "one", inputId: "correct", text: "纠正：现在只喝白开水" }); await f.app.waitForIdle();
    phase = "retry"; await f.app.receive({ conversationId: "one", inputId: "retry", text: "核对旧资料的后台学习边界" }); await f.app.waitForIdle();
    assert.match(retryResult, /retired|superseded|已替代|已撤回/i);
    assert.doesNotMatch(retryResult, /被重新学习的旧偏好/);
  } finally { await f.close(); }
});

test("later native compaction excludes superseded originals from background learning", { timeout: 60_000 }, async () => {
  let phase = "seed"; let sourceId = ""; let targetId = ""; let refinements = 0; const finalRequests: string[] = [];
  const f = await assistantFixture((wire, response) => {
    const serialized = JSON.stringify(wire.messages);
    if (serialized.includes("nailong-memory-refinement")) {
      refinements++; assert.doesNotMatch(serialized, /我喜欢橘子/);
      return sendChatCompletion(response, JSON.stringify([{ action: "add", kind: "MEMORY", content: "回灌旧偏好：橘子", quote: "我喜欢橘子", sourceId }]));
    }
    if (serialized.includes("context summarization assistant")) return sendChatCompletion(response, "## Goal\nContinue the current orchard task.\n## Progress\nCurrent preference was corrected; inspect active memory.\n## Next Steps\nFinish orchard plan.");
    if (phase === "ask") finalRequests.push(serialized);
    if (wire.messages.at(-1)?.role !== "tool") {
      if (phase === "seed") {
        sourceId = serialized.match(/sourceId=(source:[a-f0-9]{64})/)?.[1] ?? "";
        return call(response, "memory_write", { action: "add", kind: "MEMORY", content: "旧偏好：橘子", quote: "我喜欢橘子", expectedVersion: 0 }, "fruit-seed");
      }
      if (phase === "correct") return call(response, "memory_write", { action: "supersede", kind: "MEMORY", content: "当前偏好：青柠", quote: "现在偏好青柠", targetId, expectedVersion: 1 }, "fruit-correction");
    }
    if (phase === "seed") targetId = lastTool(wire).match(/memory:[a-f0-9-]{36}/)?.[0] ?? targetId;
    sendChatCompletion(response, "继续当前果园任务");
  }, async () => ({
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl: "", contextWindow: 7000, maxTokens: 1024 }] },
    compaction: { reserveTokens: 1500, keepRecentTokens: 600, backgroundTokens: 0 }, reportFailure() {},
  }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "seed", text: "记住我喜欢橘子" }); await f.app.waitForIdle(); assert.ok(targetId);
    phase = "correct"; await f.app.receive({ conversationId: "one", inputId: "correct", text: "纠正：现在偏好青柠" }); await f.app.waitForIdle();
    phase = "fill";
    for (let index = 0; index < 5; index++) { await f.app.receive({ conversationId: "one", inputId: `orchard-${index}`, text: `orchard-${index}: ` + "orchard material ".repeat(300) }); await f.app.waitForIdle(); }
    assert.ok(refinements > 0, "native compaction must reach the actual background model endpoint");
    await f.app.receive({ conversationId: "one", inputId: "reset", text: "/reset" }); await f.app.waitForIdle(); await f.reopen(); phase = "ask";
    await f.app.receive({ conversationId: "one", inputId: "ask", text: "继续当前偏好的果园安排" }); await f.app.waitForIdle();
    assert.match(finalRequests.at(-1)!, /当前偏好：青柠/); assert.doesNotMatch(finalRequests.at(-1)!, /回灌旧偏好|旧偏好：橘子/);
  } finally { await f.close(); }
});
