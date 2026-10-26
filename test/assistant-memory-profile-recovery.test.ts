import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

test("reopen repairs old unavailable refinement receipts without replaying main work", { timeout: 60_000 }, async () => {
  let available = false; let recovered = false; let mainRequests = 0; let lastRequest = "";
  const f = await assistantFixture((wire, response) => {
    const text = JSON.stringify(wire.messages);
    if (text.includes("nailong-memory-refinement")) {
      if (!available) { response.writeHead(503); response.end("temporary outage"); return; }
      const { originalSources } = JSON.parse(String(wire.messages.find(message => message.role === "user")!.content));
      const evidence = originalSources.find((source: { text: string }) => source.text.includes("amber notebooks"));
      recovered ||= !!evidence;
      return sendChatCompletion(response, JSON.stringify(evidence ? [{ action: "add", kind: "MEMORY", content: "偏好琥珀色笔记本", quote: "amber notebooks", sourceId: evidence.id }] : []));
    }
    if (text.includes("context summarization assistant")) return sendChatCompletion(response, "## Goal\nContinue notebooks.\n## Progress\nDiscussed preferences.\n## Next Steps\nContinue.");
    mainRequests++; lastRequest = text; sendChatCompletion(response, "继续笔记");
  }, async () => ({
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl: "", contextWindow: 7000, maxTokens: 1024 }] },
    compaction: { reserveTokens: 1500, keepRecentTokens: 600, backgroundTokens: 0 }, reportFailure() {},
  }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "seed", text: "I prefer amber notebooks" }); await f.app.waitForIdle();
    for (let index = 0; index < 5; index++) {
      await f.app.receive({ conversationId: "one", inputId: `fill-${index}`, text: `notes-${index}: ` + "notebook material ".repeat(300) }); await f.app.waitForIdle();
    }
    await f.app.close();
    // Represent the previous release's persisted state: terminal unavailable task, no profile job.
    const directory = join(f.options.dataDir!, "executions", createHash("sha256").update("one").digest("hex"));
    const durable = new DatabaseSync(join(directory, "session.sqlite"));
    try {
      const tasks = durable.prepare("SELECT id,record FROM tasks WHERE kind=? AND status='terminal'").all(JSON.stringify("nailong.memory-refinement")) as { id: number; record: string }[];
      assert.ok(tasks.length, "fixture must contain a completed compaction/refinement pair");
      for (const row of tasks) {
        const task = JSON.parse(row.record); task.state.outcome.result = { status: "unavailable" };
        durable.prepare("UPDATE tasks SET record=? WHERE id=?").run(JSON.stringify(task), row.id);
      }
    } finally { durable.close(); }
    const memory = new DatabaseSync(join(f.options.dataDir!, "assistant-memory.sqlite"));
    try { memory.exec("DELETE FROM memory_profile_jobs"); } finally { memory.close(); }
    available = true;
    const beforeReopen = mainRequests;
    await f.reopen();
    const deadline = Date.now() + 4000;
    while (!recovered && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(recovered, "old terminal failures must be recovered without a new input");
    assert.equal(mainRequests, beforeReopen, "archive recovery must not replay the main conversation");
    await f.app.receive({ conversationId: "one", inputId: "ask", text: "继续笔记工作" }); await f.app.waitForIdle();
    assert.match(lastRequest, /偏好琥珀色笔记本/);
  } finally { await f.close(); }
});
