import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { embeddingFixture } from "./fixtures/embedding.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

for (const mode of ["snapshot", "bounded-local", "bounded-semantic"] as const) {
  test(`${mode}: distinct facts and topics from one input survive reset and reopen`, { timeout: 15000 }, async () => {
    const remote = mode === "bounded-semantic" ? await embeddingFixture(() => [1, 0, 0]) : undefined;
    const wires: Wire[] = [];
    let writes = 0;
    const facts = [
      { kind: "MEMORY", content: "偏好：茉莉茶", quote: "我喝茉莉茶" },
      { kind: "MEMORY", content: "饮食禁忌：不吃香菜", quote: "我不吃香菜" },
      { kind: "topic", topic: "香菜", content: "香菜菜谱需要替换配料", quote: "香菜菜谱需要替换配料" },
    ];
    const f = await assistantFixture((wire, response) => {
      wires.push(wire);
      if (writes < facts.length && (wire.messages.at(-1)?.role === "tool" || JSON.stringify(wire.messages.at(-1)).includes("记住三件事"))) {
        const fact = facts[writes]!;
        sendChatCompletion(response, "", [{ index: 0, id: `fact-${writes}`, type: "function", function: {
          name: "memory_write", arguments: JSON.stringify({ action: "add", ...fact, expectedVersion: writes++ }),
        } }]);
      } else sendChatCompletion(response, "已记录");
    }, async () => ({
      memory: { residentBytes: mode === "snapshot" ? 6000 : 256 },
      ...(remote ? { embedding: { env: { KEY: "test" }, configs: [{ id: "local", displayName: "Local", baseUrl: remote.baseUrl, model: "test", apiKeyEnv: "KEY" }] } } : {}),
    }));
    try {
      await f.app.receive({ conversationId: "one", inputId: "remember", text: "记住三件事：我喝茉莉茶；我不吃香菜；香菜菜谱需要替换配料。" });
      await f.app.waitForIdle();
      assert.match(JSON.stringify(wires.at(-1)?.messages), /饮食禁忌：不吃香菜/);
      if (remote) {
        const deadline = Date.now() + 4000;
        while ((await f.app.controlSnapshot("one")).embedding.progress.completed < 2 && Date.now() < deadline) await delay(15);
        assert.ok((await f.app.controlSnapshot("one")).embedding.progress.completed >= 2);
      }
      await f.app.control("one", { type: "reset", operationId: "fresh-generation" });
      await f.reopen();
      await f.app.receive({ conversationId: "one", inputId: "question", text: "香菜菜谱怎样安排？" });
      await f.app.waitForIdle();
      const request = wires.at(-1)!;
      const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
      if (mode === "snapshot") {
        assert.match(system, /偏好：茉莉茶/);
        assert.match(system, /饮食禁忌：不吃香菜/);
      } else {
        assert.doesNotMatch(system, /饮食禁忌：不吃香菜/);
        assert.match(JSON.stringify(request.messages), /原文：记住三件事：我喝茉莉茶；我不吃香菜/);
      }
      assert.match(JSON.stringify(request.messages), /topic:香菜[^]*香菜菜谱需要替换配料/);
      const recalled = JSON.stringify(request.messages.filter(message => message.role === "user"));
      await f.reopen();
      await f.app.receive({ conversationId: "one", inputId: "next-question", text: "再确认一下香菜菜谱" });
      await f.app.waitForIdle();
      assert.ok(JSON.stringify(wires.at(-1)?.messages).includes("香菜菜谱需要替换配料"));
      assert.ok(JSON.stringify(wires.at(-1)?.messages.filter(message => message.role === "user")).includes(recalled.slice(1, -1)), "saved recall is reused after reopen");
    } finally { await f.close(); await remote?.close(); }
  });
}
