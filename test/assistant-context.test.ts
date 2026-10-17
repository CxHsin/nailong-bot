import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RequestMetric } from "../src/assistant/durable-models.js";

test("assistant reports actual provider request sizes and preserves the encoded prefix across reopen", { timeout: 15000 }, async () => {
  const requests: Wire[] = [];
  const metrics: unknown[] = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(wire);
    sendChatCompletion(response, "acknowledged");
  }, async () => ({ onRequestMetrics: (metric: unknown) => { metrics.push(metric); } }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "first", text: "first original input" });
    await f.app.waitForIdle();
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "second", text: "second original input" });
    await f.app.waitForIdle();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1]!.tools, requests[0]!.tools);
    assert.deepEqual(requests[1]!.messages.slice(0, requests[0]!.messages.length), requests[0]!.messages);
    assert.equal(metrics.length, 2);
    const measured = metrics[0] as { requestBytes: number; model: string; durationMs: number; cacheRead: number | null };
    assert.ok(measured.requestBytes > 0);
    assert.equal(measured.model, "local");
    assert.ok(measured.durationMs >= 0);
    assert.equal(measured.cacheRead, null, "a controlled endpoint with no usage cannot prove cache hits");
  } finally { await f.close(); }
});

test("a frozen snapshot receives new shared memory as persistent appended material", { timeout: 15000 }, async () => {
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(wire);
    const latest = JSON.stringify(wire.messages.at(-1));
    if (wire.messages.at(-1)?.role === "user" && latest.includes("记住我偏好青瓷杯"))
      sendChatCompletion(response, "", [{ index: 0, id: "shared-preference", type: "function", function: { name: "memory_write",
        arguments: JSON.stringify({ action: "add", kind: "MEMORY", content: "用户偏好青瓷杯", quote: "我偏好青瓷杯", expectedVersion: 0 }) } }]);
    else sendChatCompletion(response, "ack");
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "establish", text: "establish existing snapshot" }); await f.app.waitForIdle();
    const system = requests.at(-1)!.messages[0];
    await f.app.receive({ conversationId: "two", inputId: "write", text: "记住我偏好青瓷杯" }); await f.app.waitForIdle();
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "continue", text: "continue existing conversation" }); await f.app.waitForIdle();
    assert.deepEqual(requests.at(-1)!.messages[0], system, "same-generation system content stays fixed");
    assert.match(JSON.stringify(requests.at(-1)!.messages.at(-1)), /用户偏好青瓷杯/);
    assert.match(JSON.stringify(requests.at(-1)!.messages.at(-1)), /记忆变更材料/);
    assert.match(await readFile(join(f.directory, "fresh", "memory", "MEMORY.md"), "utf8"), /用户偏好青瓷杯/);
  } finally { await f.close(); }
});

test("native capacity compaction preserves recent input and resumes after reopening", { timeout: 30000 }, async () => {
  let summaries = 0;
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => {
    if (JSON.stringify(wire.messages[0]).includes("context summarization assistant")) {
      summaries++;
      sendChatCompletion(response, "## Goal\nContinue the garden plan.\n## Progress\n### Done\n- Selected lotus\n### In Progress\n- Plan watering\n### Blocked\n- none\n## Key Decisions\n- use rainwater\n## Next Steps\n1. Continue watering\n## Critical Context\n- garden.txt");
    } else { requests.push(wire); sendChatCompletion(response, "continue garden plan"); }
  }, async () => ({
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl: "", contextWindow: 7000, maxTokens: 1024 }] },
    compaction: { reserveTokens: 1500, keepRecentTokens: 600, backgroundTokens: 0 },
  }));
  try {
    for (let index = 0; index < 5; index++) {
      await f.app.receive({ conversationId: "one", inputId: `garden-${index}`, text: `garden-${index}: ` + "garden material ".repeat(300) });
      await f.app.waitForIdle();
    }
    assert.ok(summaries > 0, "must execute the native summarizer through the provider");
    assert.match(JSON.stringify(requests.at(-1)), /garden-4/);
    assert.match(JSON.stringify(requests.at(-1)), /Selected lotus/);
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "continue", text: "continue watering" });
    await f.app.waitForIdle();
    assert.match(JSON.stringify(requests.at(-1)), /Selected lotus/);
    assert.match(JSON.stringify(requests.at(-1)), /continue watering/);
  } finally { await f.close(); }
});

test("native compaction refines its covered original user evidence into memory", { timeout: 30000 }, async () => {
  let refinements = 0;
  let summaries = 0;
  const requests: Wire[] = [];
  const metrics: RequestMetric[] = [];
  const f = await assistantFixture((wire, response) => {
    const text = JSON.stringify(wire.messages);
    if (text.includes("nailong-memory-refinement")) {
      refinements++;
      assert.doesNotMatch(text, /GLOBAL_ONLY_EVIDENCE/, "shared snapshot facts are not original evidence from this conversation");
      const sourceId = text.match(/source:[a-f0-9]{64}/)?.[0];
      sendChatCompletion(response, JSON.stringify([{ action: "add", kind: "MEMORY", content: "用户偏好荷花", quote: "我喜欢荷花", sourceId }]));
    } else if (text.includes("context summarization assistant")) {
      summaries++;
      sendChatCompletion(response, "## Goal\nContinue garden.\n## Progress\n### Done\n- started\n### In Progress\n- watering\n## Next Steps\n1. Continue");
    } else if (wire.messages.at(-1)?.role === "user" && text.includes("记住共享偏好GLOBAL_ONLY_EVIDENCE")) {
      sendChatCompletion(response, "", [{ index: 0, id: "global-evidence", type: "function", function: { name: "memory_write",
        arguments: JSON.stringify({ action: "add", kind: "MEMORY", content: "GLOBAL_ONLY_EVIDENCE", quote: "GLOBAL_ONLY_EVIDENCE", expectedVersion: 0 }) } }]);
    } else { requests.push(wire); sendChatCompletion(response, "recorded garden conversation"); }
  }, async () => ({
    onRequestMetrics: metric => { metrics.push(metric); },
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl: "", contextWindow: 7000, maxTokens: 1024 }] },
    compaction: { reserveTokens: 1500, keepRecentTokens: 600, backgroundTokens: 0 },
  }));
  try {
    await f.app.receive({ conversationId: "shared", inputId: "global", text: "记住共享偏好GLOBAL_ONLY_EVIDENCE" }); await f.app.waitForIdle();
    for (let index = 0; index < 5; index++) {
      await f.app.receive({ conversationId: "one", inputId: `memory-garden-${index}`, text: (index === 0 ? "我喜欢荷花。" : "garden ") + "garden material ".repeat(300) });
      await f.app.waitForIdle();
    }
    assert.ok(refinements > 0, "the covered raw inputs must be refined after actual compaction");
    await f.app.receive({ conversationId: "one", inputId: "reset-refinement", text: "/reset" });
    await f.app.waitForIdle();
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "flowers", text: "我喜欢什么花？" });
    await f.app.waitForIdle();
    assert.match(JSON.stringify(requests.at(-1)), /用户偏好荷花/);
    assert.equal(metrics.filter(metric => metric.purpose === "auxiliary").length, summaries + refinements);
    assert.equal(metrics.filter(metric => metric.purpose === "execution").length, requests.length + 1);
    assert.ok(metrics.every(metric => metric.batchId && metric.requestId));
  } finally { await f.close(); }
});

test("forgetting rebuilds an affected native checkpoint while preserving unrelated work progress", { timeout: 30000 }, async () => {
  let phase = "seed"; let sourceId = ""; let summaries = 0; let rebuilt = 0; let rejectedCleanCompaction = false;
  const requests: string[] = [];
  const f = await assistantFixture((wire, response) => {
    const serialized = JSON.stringify(wire.messages);
    if (serialized.includes("nailong-forget-summary")) {
      rebuilt++;
      assert.doesNotMatch(serialized, /MAGENTA_PROFILE|purple breakfast/);
      return sendChatCompletion(response, "## Goal\nFinish the ledger report.\n## Progress\n### Done\n- Input file checked\n### In Progress\n- Writing ledger\n## Next Steps\n1. Complete ledger.txt");
    }
    if (serialized.includes("nailong-memory-refinement")) return sendChatCompletion(response, "[]");
    if (serialized.includes("context summarization assistant")) {
      summaries++;
      if (phase === "post-forget" || rebuilt > 0) {
        assert.doesNotMatch(serialized, /MAGENTA_PROFILE|purple breakfast/);
        if (!rejectedCleanCompaction) {
          rejectedCleanCompaction = true;
          response.writeHead(503); response.end("temporary clean compaction failure"); return;
        }
        return sendChatCompletion(response, "## Goal\nFinish the ledger report.\n## Progress\n### Done\n- Input file checked\n## Next Steps\n1. Complete ledger.txt");
      }
      return sendChatCompletion(response, "## Goal\nFinish the ledger report.\n## Progress\n### Done\n- Input file checked\n## Critical Context\n- MAGENTA_PROFILE: purple breakfast");
    }
    requests.push(serialized);
    if (phase === "seed") {
      sourceId = serialized.match(/sourceId=(source:[a-f0-9]{64})/)?.[1] ?? sourceId;
      if (wire.messages.at(-1)?.role !== "tool") return sendChatCompletion(response, "", [{ index: 0, id: "remember-covered-origin", type: "function", function: { name: "memory_write",
        arguments: JSON.stringify({ action: "add", kind: "MEMORY", content: "MAGENTA_PROFILE: purple breakfast", quote: "我的早餐习惯是紫色花茶", expectedVersion: 0 }) } }]);
      return sendChatCompletion(response, "MAGENTA_PROFILE: purple breakfast is your recorded habit");
    }
    if (phase === "forget" && wire.messages.at(-1)?.role !== "tool") {
      return sendChatCompletion(response, "", [{ index: 0, id: "forget-covered-origin", type: "function", function: { name: "memory_forget",
        arguments: JSON.stringify({ id: sourceId, expectedVersion: 1 }) } }]);
    }
    sendChatCompletion(response, "continue ledger report");
  }, async () => ({
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl: "", contextWindow: 7000, maxTokens: 1024 }] },
    compaction: { reserveTokens: 1500, keepRecentTokens: 600, backgroundTokens: 0 },
  }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "habit", text: "我的早餐习惯是紫色花茶" }); await f.app.waitForIdle();
    await f.app.receive({ conversationId: "one", inputId: "reset-before-work", text: "/reset" }); await f.app.waitForIdle();
    phase = "work";
    for (let index = 0; index < 4; index++) {
      await f.app.receive({ conversationId: "one", inputId: `ledger-${index}`, text: "Finish ledger report; input file checked; " + "ledger material ".repeat(300) }); await f.app.waitForIdle();
    }
    assert.ok(summaries > 0);
    phase = "forget";
    await f.app.receive({ conversationId: "one", inputId: "forget", text: "忘记我的早餐习惯，继续台账工作" }); await f.app.waitForIdle();
    assert.ok(rebuilt > 0, "an affected summary must be rebuilt from surviving raw sources");
    assert.match(requests.at(-1)!, /Finish the ledger report|Input file checked/);
    assert.doesNotMatch(requests.at(-1)!, /MAGENTA_PROFILE|purple breakfast/);
    const before = rebuilt;
    await f.reopen(); phase = "work";
    await f.app.receive({ conversationId: "one", inputId: "continue-ledger", text: "continue ledger report" }); await f.app.waitForIdle();
    assert.equal(rebuilt, before, "reopen reuses the saved safe checkpoint");
    assert.match(requests.at(-1)!, /Input file checked/);
    phase = "post-forget";
    const priorCompactions = summaries;
    for (let index = 0; index < 3; index++) {
      await f.app.receive({ conversationId: "one", inputId: `clean-ledger-${index}`, text: "Continue ledger report; " + "ledger material ".repeat(300) }); await f.app.waitForIdle();
    }
    assert.ok(rejectedCleanCompaction, "after reaching a clean compaction boundary, its failure must not fall back to forgotten raw context");
    assert.ok(summaries > priorCompactions, "later native compaction must consume the cleaned checkpoint");
    assert.doesNotMatch(requests.at(-1)!, /MAGENTA_PROFILE|purple breakfast/);
    assert.match(requests.at(-1)!, /Input file checked/);
  } finally { await f.close(); }
});
