import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

test("failed profile extraction resumes after reopen without a new message and appears in the next request", { timeout: 60_000 }, async () => {
  let now = Date.now(); let available = false; let failures = 0; let successes = 0; const requests: string[] = []; const profileModels: string[] = [];
  const f = await assistantFixture((wire, response) => {
    const text = JSON.stringify(wire.messages);
    if (text.includes("nailong-memory-refinement")) {
      profileModels.push((wire as unknown as { model: string }).model);
      if (!available) { failures++; response.writeHead(503); response.end("temporary outage"); return; }
      const evidence = JSON.parse(String(wire.messages.find(message => message.role === "user")!.content)).originalSources;
      const source = evidence.find((item: { text: string }) => item.text.includes("violet notebooks"));
      successes++;
      return sendChatCompletion(response, JSON.stringify(source ? [{ action: "add", kind: "MEMORY", content: "偏好紫色笔记本", quote: "violet notebooks", sourceId: source.id }] : []));
    }
    if (text.includes("context summarization assistant")) return sendChatCompletion(response, "## Goal\nContinue notes.\n## Progress\nDiscussed notebooks.\n## Next Steps\nContinue.");
    requests.push(text); sendChatCompletion(response, "继续笔记工作");
  }, async () => ({
    now: () => now,
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl: "", contextWindow: 7000, maxTokens: 1024 }] },
    compaction: { reserveTokens: 1500, keepRecentTokens: 600, backgroundTokens: 0 }, reportFailure() {},
  }), { catalog: ["local", "selected/profile"].map(id => ({ id, context_window: 7000, max_output_tokens: 1024, reasoning: false })), primaryConversationId: "one" });
  try {
    await f.app.receive({ conversationId: "one", inputId: "seed", text: "I prefer violet notebooks" }); await f.app.waitForIdle();
    for (let index = 0; index < 5; index++) {
      await f.app.receive({ conversationId: "one", inputId: `fill-${index}`, text: `notes-${index}: ` + "notebook material ".repeat(300) }); await f.app.waitForIdle();
    }
    assert.ok(failures > 0);
    const initialFailures = failures; now += 30_001;
    const retryDeadline = Date.now() + 3000;
    while (failures === initialFailures && Date.now() < retryDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(failures > initialFailures, "delayed retry must run without receiving another message");
    await f.app.control("one", { type: "model", model: "selected/profile" });
    available = true; await f.reopen();
    const deadline = Date.now() + 3000;
    while (!successes && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(successes > 0, "persisted extraction must retry without receiving another message");
    assert.equal(profileModels.at(-1), "selected/profile", "recovered extraction uses the actual saved menu selection");
    await f.app.receive({ conversationId: "one", inputId: "ask", text: "继续笔记工作" }); await f.app.waitForIdle();
    assert.match(requests.at(-1)!, /偏好紫色笔记本/);
  } finally { await f.close(); }
});

for (const kind of ["MEMORY", "topic"] as const) test(`${kind} consolidation waits a day and five applied drafts, then merged provenance honors forgetting either original`, { timeout: 60_000 }, async () => {
  let now = Date.now(); let phase = "fill"; let drafts = 0; let merged = false; let secondSource = ""; let receipt = ""; let answeredFromTopic = false; const requests: string[] = [];
  const f = await assistantFixture((wire, response) => {
    const text = JSON.stringify(wire.messages);
    if (text.includes("nailong-memory-refinement")) {
      drafts++;
      const input = JSON.parse(String(wire.messages.find(message => message.role === "user")!.content));
      return sendChatCompletion(response, JSON.stringify(input.originalSources.filter((source: { text: string }) => /fruit evidence (apricot|blueberry)/.test(source.text)).map((source: { id: string; text: string }) => {
        const fruit = source.text.includes("apricot") ? "apricot" : "blueberry";
        if (fruit === "blueberry") secondSource = source.id;
        return { action: "add", kind, ...(kind === "topic" ? { topic: "fruit" } : {}), content: `fruit fact ${fruit}`, quote: `fruit evidence ${fruit}`, sourceId: source.id };
      })));
    }
    if (text.includes("nailong-memory-consolidation")) {
      const input = JSON.parse(String(wire.messages.find(message => message.role === "user")!.content));
      const entries = input.currentProfiles.filter((entry: { kind: string }) => entry.kind === kind);
      assert.ok(entries.length >= 2); merged = true;
      return sendChatCompletion(response, JSON.stringify([{ ids: entries.slice(0, 2).map((entry: { id: string }) => entry.id), content: "fruit merged apricot and blueberry" }]));
    }
    if (text.includes("context summarization assistant")) return sendChatCompletion(response, "## Goal\nFruit work.\n## Progress\nContinue.\n## Next Steps\nPlan.");
    if (phase === "forget" && wire.messages.at(-1)?.role !== "tool") return sendChatCompletion(response, "", [{ index: 0, id: "forget-second", type: "function", function: { name: "memory_forget", arguments: JSON.stringify({ id: secondSource, expectedVersion: 3 }) } }]);
    if (phase === "inspect" && wire.messages.at(-1)?.role !== "tool") return sendChatCompletion(response, "", [{ index: 0, id: "remaining-original", type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query: "fruit evidence" }) } }]);
    if (phase === "forget") receipt = String(wire.messages.at(-1)?.content);
    if (phase === "inspect") receipt = String(wire.messages.at(-1)?.content);
    if (phase === "ask") {
      requests.push(text);
      if (kind === "topic" && !answeredFromTopic) { answeredFromTopic = true; return sendChatCompletion(response, "派生果园解释：银叶主题的长期理解 TOPIC-DERIVED-RESPONSE"); }
    }
    sendChatCompletion(response, "继续果园任务");
  }, async () => ({
    now: () => now,
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl: "", contextWindow: 7000, maxTokens: 1024 }] },
    compaction: { reserveTokens: 1500, keepRecentTokens: 600, backgroundTokens: 0 }, reportFailure() {},
  }));
  try {
    for (const fruit of ["apricot", "blueberry"]) { await f.app.receive({ conversationId: "one", inputId: fruit, text: `fruit evidence ${fruit}` }); await f.app.waitForIdle(); }
    for (let index = 0; index < 14 && drafts < 5; index++) { await f.app.receive({ conversationId: "one", inputId: `fill-${index}`, text: "orchard material ".repeat(300) }); await f.app.waitForIdle(); }
    assert.ok(drafts >= 5); assert.equal(merged, false);
    now += 86_400_001;
    const deadline = Date.now() + 3000;
    while (!merged && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(merged); await new Promise(resolve => setTimeout(resolve, 100));
    await f.reopen(); phase = "ask";
    await f.app.receive({ conversationId: "reader", inputId: "before", text: "continue fruit work" }); await f.app.waitForIdle();
    assert.match(requests.at(-1)!, /fruit merged apricot and blueberry/);
    phase = "forget"; await f.app.receive({ conversationId: "writer", inputId: "forget", text: "忘记blueberry资料" }); await f.app.waitForIdle(); assert.doesNotMatch(receipt, /\[error\]/);
    phase = "ask"; await f.app.receive({ conversationId: "reader", inputId: "after", text: "continue fruit work" }); await f.app.waitForIdle();
    assert.doesNotMatch(requests.at(-1)!, /fruit merged apricot and blueberry|TOPIC-DERIVED-RESPONSE/);
    await f.reopen();
    await f.app.receive({ conversationId: "reader", inputId: "after-reopen", text: "继续原果园工作" }); await f.app.waitForIdle();
    assert.doesNotMatch(requests.at(-1)!, /fruit merged apricot and blueberry|TOPIC-DERIVED-RESPONSE/);
    phase = "inspect"; await f.app.receive({ conversationId: "writer", inputId: "inspect", text: "查询仍有效的果园原始资料" }); await f.app.waitForIdle();
    assert.match(receipt, /fruit evidence apricot/); assert.doesNotMatch(receipt, /fruit evidence blueberry/);
  } finally { await f.close(); }
});

test("quota maintenance independently retires profile display while preserving searchable original evidence and SELF", { timeout: 60_000 }, async () => {
  let phase = "write"; let result = ""; let consolidation = 0; const systems: string[] = [];
  const f = await assistantFixture((wire, response) => {
    const text = JSON.stringify(wire.messages);
    if (text.includes("nailong-memory-consolidation")) { consolidation++; return sendChatCompletion(response, "[]"); }
    if (wire.messages.at(-1)?.role !== "tool") {
      systems.push(String(wire.messages[0]?.content));
      const name = phase === "write" ? "memory_write" : "memory_search";
      const args = phase === "write" ? { action: "add", kind: "topic", topic: "quota", content: "quota裁剪档案".repeat(60), quote: "quota original evidence", expectedVersion: 0 } : { query: "quota" };
      return sendChatCompletion(response, "", [{ index: 0, id: phase, type: "function", function: { name, arguments: JSON.stringify(args) } }]);
    }
    if (phase === "ask") result = String(wire.messages.at(-1)?.content);
    sendChatCompletion(response, "已处理");
  }, async () => ({ memory: { topicBytes: 800 }, reportFailure() {} }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "seed", text: "Save quota original evidence" }); await f.app.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 1200));
    await f.reopen(); phase = "ask";
    await f.app.receive({ conversationId: "one", inputId: "ask", text: "Search quota evidence" }); await f.app.waitForIdle();
    assert.match(result, /quota original evidence/); assert.doesNotMatch(result, /quota裁剪档案/);
    assert.equal(consolidation, 0, "quota pruning does not depend on consolidation eligibility");
    assert.match(systems.at(-1)!, /我是用户的私人助手奶龙/);
  } finally { await f.close(); }
});

test("profile drafts correct an invalid whole batch and overlay concurrent writes using current profile evidence", { timeout: 60_000 }, async () => {
  let phase = "seed"; let corrected = false; let first = true;
  let begin!: () => void; const started = new Promise<void>(resolve => { begin = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let writerDone!: () => void; const written = new Promise<void>(resolve => { writerDone = resolve; });
  const requests: string[] = [];
  const f = await assistantFixture(async (wire, response) => {
    const text = JSON.stringify(wire.messages);
    const tool = (args: object, id: string) => sendChatCompletion(response, "", [{ index: 0, id, type: "function", function: { name: "memory_write", arguments: JSON.stringify(args) } }]);
    if (text.includes("nailong-memory-refinement")) {
      const input = JSON.parse(String(wire.messages.find(message => message.role === "user")!.content));
      const source = input.originalSources.find((item: { text: string }) => item.text.includes("violet notebooks"));
      if (!source) return sendChatCompletion(response, "[]");
      assert.ok(input.currentProfiles.some((entry: { content: string }) => entry.content === "既有档案：笔记工作"));
      if (first) {
        first = false; begin(); await gate;
        return sendChatCompletion(response, JSON.stringify([
          { action: "add", kind: "MEMORY", content: "坏批次不可部分应用", sourceId: source.id, quote: "violet notebooks" },
          { action: "add", kind: "MEMORY", content: "无依据条目", sourceId: source.id, quote: "not in evidence" },
        ]));
      }
      if (input.correction) corrected = true;
      return sendChatCompletion(response, JSON.stringify([{ action: "add", kind: "MEMORY", content: "提炼偏好：紫色笔记本", sourceId: source.id, quote: "violet notebooks" }]));
    }
    if (text.includes("context summarization assistant")) return sendChatCompletion(response, "## Goal\nContinue notes.\n## Progress\nNotes.\n## Next Steps\nContinue.");
    if (wire.messages.at(-1)?.role !== "tool") {
      if (phase === "seed") return tool({ action: "add", kind: "MEMORY", content: "既有档案：笔记工作", quote: "violet notebooks", expectedVersion: 0 }, "initial");
      if (phase === "writer" && text.includes("并发记住")) return tool({ action: "add", kind: "MEMORY", content: "并发更新：蓝色墨水", quote: "我使用蓝色墨水", expectedVersion: 1 }, "concurrent");
      if (phase === "ask") return sendChatCompletion(response, "", [{ index: 0, id: "inspect-profile", type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query: "紫色" }) } }]);
    } else if (phase === "writer") writerDone();
    if (phase === "ask") requests.push(text);
    sendChatCompletion(response, "继续笔记工作");
  }, async () => ({
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl: "", contextWindow: 7000, maxTokens: 1024 }] },
    compaction: { reserveTokens: 1500, keepRecentTokens: 600, backgroundTokens: 0 }, reportFailure() {},
  }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "seed", text: "I prefer violet notebooks" }); await f.app.waitForIdle(); phase = "fill";
    const fill = (async () => { for (let index = 0; index < 5; index++) {
      await f.app.receive({ conversationId: "one", inputId: `fill-${index}`, text: "notebook material ".repeat(300) }); await f.app.waitForIdle();
    } })();
    await started; phase = "writer";
    await f.app.receive({ conversationId: "writer", inputId: "write", text: "并发记住：我使用蓝色墨水" }); await written; release(); await fill; await f.app.waitForIdle();
    assert.ok(corrected, "an invalid draft receives one whole-batch correction");
    phase = "ask"; await f.app.receive({ conversationId: "one", inputId: "ask", text: "继续笔记偏好" }); await f.app.waitForIdle();
    assert.match(requests.at(-1)!, /并发更新：蓝色墨水/); assert.match(requests.at(-1)!, /提炼偏好：紫色笔记本/);
    assert.doesNotMatch(requests.at(-1)!, /坏批次不可部分应用|无依据条目/);
  } finally { release(); await f.close(); }
});
