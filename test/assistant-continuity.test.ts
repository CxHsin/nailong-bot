import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { embeddingFixture } from "./fixtures/embedding.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";
import { PersistentAssistantQueue } from "../src/assistant/queue.js";

function tool(response: Parameters<typeof sendChatCompletion>[0], name: string, args: object, id: string) {
  return sendChatCompletion(response, "", [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]);
}

async function waitForEmbedding(f: Awaited<ReturnType<typeof assistantFixture>>, conversationId: string, minimum: number) {
  const deadline = Date.now() + 4000;
  while ((await f.app.controlSnapshot(conversationId)).embedding.progress.completed < minimum && Date.now() < deadline) await delay(15);
}

test("shared experience recall keeps relevant provenance across reset/reopen and isolates unrelated history", { timeout: 20000 }, async () => {
  const remote = await embeddingFixture((text) => /自行车/.test(text) ? [0, 0, 1] : /白茶|饮品/.test(text) ? [1, 0, 0] : [0, 1, 0]);
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(wire);
    const last = JSON.stringify(wire.messages.at(-1)?.content);
    sendChatCompletion(response, last.includes("自行车") ? "自行车事项已收到。" : "白茶经历已收到。");
  }, async () => ({ embedding: { env: { KEY: "continuity-embedding" }, configs: [
    { id: "continuity", displayName: "Continuity", baseUrl: remote.baseUrl, model: "continuity", apiKeyEnv: "KEY" },
  ] } }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "tea", text: "我在月桥喝过白茶，记得那次共同经历。" }); await f.app.waitForIdle();
    await f.app.receive({ conversationId: "one", inputId: "bike", text: "我在北海修理自行车。" }); await f.app.waitForIdle();
    await waitForEmbedding(f, "one", 4);
    await f.app.control("one", { type: "reset", operationId: "continuity-reset" }); await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "tea-follow-up", text: "以前说过的饮品口味是哪种？" }); await f.app.waitForIdle();
    const material = JSON.stringify(requests.at(-1)?.messages);
    assert.match(material, /原文：我在月桥喝过白茶，记得那次共同经历。/);
    assert.match(material, /source=source:[a-f0-9]{64} role=user/);
    const directBlocks = material.split("\\n[source=").filter((block) => block.includes("lane=direct"));
    assert.ok(directBlocks.length > 0, "relevant recall is a direct-lane experience");
    assert.ok(directBlocks.every((block) => !block.includes("我在北海修理自行车")), "unrelated history does not enter the relevant direct recall lane");
  } finally { await f.close(); await remote.close(); }
});

test("correction and forgetting survive reset/reopen while paused work remains unfinished and produces no offline completion", { timeout: 20000 }, async () => {
  let phase: "remember" | "correct" | "forget" | "query" = "remember";
  let originalSource = "";
  let memoryId = "";
  let forgetResult = "";
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(wire);
    const serialized = JSON.stringify(wire.messages);
    if (wire.messages.at(-1)?.role !== "tool") {
      if (phase === "remember") {
        originalSource = serialized.match(/sourceId=(source:[a-f0-9]{64})/)?.[1] ?? "";
        return tool(response, "memory_write", { action: "add", kind: "MEMORY", content: "旧偏好：浓咖啡", quote: "我喜欢浓咖啡", expectedVersion: 0 }, "remember-old");
      }
      if (phase === "correct") return tool(response, "memory_write", { action: "supersede", kind: "MEMORY", content: "当前偏好：白开水", quote: "现在只喝白开水", targetId: memoryId, expectedVersion: 1 }, "correct-new");
      if (phase === "forget") return tool(response, "memory_forget", { id: memoryId, expectedVersion: 2 }, "forget-new");
    }
    if (wire.messages.at(-1)?.role === "tool") forgetResult = String(wire.messages.at(-1)?.content ?? "");
    sendChatCompletion(response, "已处理当前输入。");
  }, async (cwd) => {
    const dataDir = join(cwd, "fresh"); await mkdir(dataDir, { recursive: true });
    const queue = new PersistentAssistantQueue(join(dataDir, "queue.sqlite"));
    try {
      const receipt = queue.receive({ conversationId: "work", inputId: "paused-work", text: "继续整理尚未完成的台账" });
      queue.settle(queue.claim("work")!.id, "paused");
      assert.ok(receipt.eventId);
    } finally { queue.close(); }
    return {};
  });
  try {
    await f.app.receive({ conversationId: "memory", inputId: "remember", text: "记住我喜欢浓咖啡" }); await f.app.waitForIdle();
    memoryId = String(requests.at(-1)?.messages.filter((message) => message.role === "tool").at(-1)?.content ?? "").match(/memory:[a-f0-9-]{36}/)?.[0] ?? "";
    assert.ok(originalSource && memoryId);
    phase = "correct"; await f.app.receive({ conversationId: "memory", inputId: "correct", text: "纠正：现在只喝白开水" }); await f.app.waitForIdle();
    memoryId = String(requests.at(-1)?.messages.filter((message) => message.role === "tool").at(-1)?.content ?? "").match(/memory:[a-f0-9-]{36}/)?.[0] ?? memoryId;
    await f.app.control("memory", { type: "reset", operationId: "before-corrected-query" }); await f.reopen();
    phase = "query"; await f.app.receive({ conversationId: "memory", inputId: "corrected-query", text: "我现在喝什么？" }); await f.app.waitForIdle();
    let material = JSON.stringify(requests.at(-1)?.messages);
    const memorySection = String(requests.at(-1)?.messages.find((message) => message.role === "system")?.content ?? "");
    assert.match(memorySection, /当前偏好：白开水/); assert.doesNotMatch(memorySection, /旧偏好：浓咖啡/);
    assert.equal((await f.app.controlSnapshot("work")).status, "paused");
    const workRequestsBeforeForget = requests.filter((wire) => JSON.stringify(wire.messages).includes("paused-work")).length;
    phase = "forget"; await f.app.receive({ conversationId: "memory", inputId: "forget", text: "忘记这个饮品偏好" }); await f.app.waitForIdle();
    await f.app.control("memory", { type: "reset", operationId: "after-forget" }); await f.reopen();
    assert.match(forgetResult, /已忘记|forgotten|排除/);
    assert.match(forgetResult, /count["']?:1/);
    phase = "query"; await f.app.receive({ conversationId: "memory", inputId: "after-forget-query", text: "查询以前的饮品偏好" }); await f.app.waitForIdle();
    material = JSON.stringify(requests.at(-1)?.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("记忆检索材料")));
    assert.doesNotMatch(material, /旧偏好：浓咖啡|当前偏好：白开水/);
    const postForgetSystem = String(requests.at(-1)?.messages.find((message) => message.role === "system")?.content ?? "");
    assert.doesNotMatch(postForgetSystem, /旧偏好：浓咖啡|当前偏好：白开水/);
    assert.equal((await f.app.controlSnapshot("work")).status, "paused");
    assert.equal(requests.filter((wire) => JSON.stringify(wire.messages).includes("paused-work")).length, workRequestsBeforeForget, "reopen does not invent an offline completion for paused work");
  } finally { await f.close(); }
});
