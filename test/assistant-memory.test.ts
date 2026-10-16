import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

test("sourced memory is available immediately and survives reset and reopen", { timeout: 12000 }, async () => {
  const seen: string[] = [];
  const f = await assistantFixture((wire, response) => {
    seen.push(JSON.stringify(wire.messages));
    if (!wire.tools.some((tool) => tool.function.name === "memory_write")) { sendChatCompletion(response, "memory tools missing"); return; }
    if (wire.messages.at(-1)?.role === "user" && JSON.stringify(wire.messages.at(-1)).includes("记住我喜欢茉莉茶")) {
      sendChatCompletion(response, "", [{ index: 0, id: "remember", type: "function", function: {
        name: "memory_write", arguments: JSON.stringify({ action: "add", kind: "MEMORY", content: "用户喜欢茉莉茶", quote: "我喜欢茉莉茶", expectedVersion: 0 }),
      } }]);
    } else sendChatCompletion(response, "已处理");
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "remember", text: "记住我喜欢茉莉茶" });
    await f.app.waitForIdle();
    assert.match(seen.at(-1)!, /用户喜欢茉莉茶/);
    await f.app.receive({ conversationId: "one", inputId: "reset", text: "/reset" });
    await f.app.waitForIdle();
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "ask", text: "我适合喝什么？" });
    await f.app.waitForIdle();
    assert.match(seen.at(-1)!, /MEMORY/);
    assert.match(seen.at(-1)!, /用户喜欢茉莉茶/);
    assert.match(seen.at(-1)!, /role.?[:=].?user|user 原文|user.*quote/);
  } finally { await f.close(); }
});

test("helper claims and mismatched user quotes cannot create user memories", { timeout: 12000 }, async () => {
  const seen: string[] = [];
  const f = await assistantFixture((wire, response) => {
    seen.push(JSON.stringify(wire.messages));
    const last = wire.messages.at(-1)!;
    const input = JSON.stringify(last.content);
    if (last.role === "user" && /helper assertion|unrelated real user/.test(input)) {
      sendChatCompletion(response, "", [{ index: 0, id: `attempt-${seen.length}`, type: "function", function: {
        name: "memory_write", arguments: JSON.stringify({ action: "add", kind: "SELF", content: "UNSUPPORTED_USER_PROFILE", quote: input.includes("helper assertion") ? "helper assertion" : "invented quotation", expectedVersion: 0 }),
      } }]);
    } else sendChatCompletion(response, "已处理");
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "helper", source: "herdr", text: "helper assertion" }); await f.app.waitForIdle();
    assert.match(seen.at(-1)!, /original user input/);
    await f.app.receive({ conversationId: "one", inputId: "user", text: "unrelated real user" }); await f.app.waitForIdle();
    assert.match(seen.at(-1)!, /matching quote/);
    await f.app.receive({ conversationId: "one", inputId: "reset", text: "/reset" }); await f.app.waitForIdle();
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "fresh", text: "fresh conversation" }); await f.app.waitForIdle();
    assert.doesNotMatch(seen.at(-1)!, /UNSUPPORTED_USER_PROFILE/);
  } finally { await f.close(); }
});

test("topic material and raw Akasha evidence preserve distinct sources after reset", { timeout: 12000 }, async () => {
  const seen: string[] = [];
  const f = await assistantFixture((wire, response) => {
    seen.push(JSON.stringify(wire.messages));
    const last = wire.messages.at(-1)!;
    if (last.role === "user" && JSON.stringify(last.content).includes("记为项目主题：红叶方案使用分批部署")) {
      sendChatCompletion(response, "", [{ index: 0, id: "topic", type: "function", function: {
        name: "memory_write", arguments: JSON.stringify({ action: "add", kind: "topic", topic: "红叶方案", content: "红叶方案采用分批部署", quote: "红叶方案使用分批部署", expectedVersion: 0 }),
      } }]);
    } else sendChatCompletion(response, "已处理");
  }, async () => ({ memory: { residentBytes: 1000, topicBytes: 1200, akashaBytes: 900, inputBytes: 2500 } }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "topic", text: "记为项目主题：红叶方案使用分批部署" }); await f.app.waitForIdle();
    await f.app.receive({ conversationId: "one", inputId: "experience", text: "红叶方案曾在星期二成功回滚，原始记录编号ROLLBACK-42" }); await f.app.waitForIdle();
    await f.app.receive({ conversationId: "one", inputId: "reset", text: "/reset" }); await f.app.waitForIdle();
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "ask", text: "红叶方案怎样部署，何时回滚？" }); await f.app.waitForIdle();
    const request = seen.at(-1)!;
    assert.match(request, /topic:红叶方案/);
    assert.match(request, /ROLLBACK-42/);
    assert.match(request, /role=user.*at=/);
    assert.equal((request.match(/红叶方案采用分批部署/g) ?? []).length, 1, "topic evidence is not injected again as raw Akasha text");
    assert.equal((request.match(/ROLLBACK-42/g) ?? []).length, 1);
  } finally { await f.close(); }
});

test("correction replaces old evidence and forgetting excludes it across reset and reopen", { timeout: 15000 }, async () => {
  const seen: string[] = []; let target = ""; let lastVersion = 0;
  const f = await assistantFixture((wire, response) => {
    const serialized = JSON.stringify(wire.messages); seen.push(serialized);
    const latest = wire.messages.at(-1)!;
    const toolResults = wire.messages.filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content));
    for (const result of toolResults) {
      const id = result.match(/memory:[a-f0-9-]{36}/)?.[0]; if (id) target = id;
      const version = result.match(/(?:\\"|\")version(?:\\"|\")\s*:\s*(\d+)/)?.[1]; if (version) lastVersion = Math.max(lastVersion, Number(version));
    }
    function call(name: string, args: unknown) { sendChatCompletion(response, "", [{ index: 0, id: `call-${seen.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]); }
    if (latest.role === "user" && JSON.stringify(latest.content).includes("首次：记住我喜欢黑咖啡")) call("memory_write", { action: "add", kind: "MEMORY", content: "偏好黑咖啡", quote: "我喜欢黑咖啡", expectedVersion: 0 });
    else if (latest.role === "user" && JSON.stringify(latest.content).includes("纠正：现在我喜欢白茶")) call("memory_write", { action: "supersede", kind: "MEMORY", targetId: target, content: "偏好白茶", quote: "现在我喜欢白茶", expectedVersion: lastVersion });
    else if (latest.role === "user" && JSON.stringify(latest.content).includes("忘记白茶偏好")) call("memory_forget", { query: "白茶", expectedVersion: lastVersion });
    else if (latest.role === "user" && JSON.stringify(latest.content).includes("查找遗忘材料")) call("memory_search", { query: "白茶" });
    else sendChatCompletion(response, "已处理");
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "first", text: "首次：记住我喜欢黑咖啡" }); await f.app.waitForIdle();
    assert.ok(target, "memory_write returns the real memory identity");
    await f.app.receive({ conversationId: "one", inputId: "correction", text: "纠正：现在我喜欢白茶" }); await f.app.waitForIdle();
    assert.match(seen.at(-1)!, /supersede/);
    await f.app.receive({ conversationId: "one", inputId: "forget", text: "忘记白茶偏好" }); await f.app.waitForIdle();
    await f.app.receive({ conversationId: "one", inputId: "reset", text: "/reset" }); await f.app.waitForIdle();
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "new", text: "查找遗忘材料" }); await f.app.waitForIdle();
    assert.doesNotMatch(seen.at(-1)!, /偏好黑咖啡|偏好白茶|现在我喜欢白茶/);
    assert.match(seen.at(-1)!, /forgotten sources excluded/);
    assert.match(seen.at(-1)!, /(?:\\"|\")results(?:\\"|\")\s*:\s*\[\]/);
  } finally { await f.close(); }
});
