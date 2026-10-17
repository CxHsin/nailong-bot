import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PersistentAssistantQueue } from "../src/assistant/queue.js";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
type Snapshot = { current: { inputId: string; text: string }; works: Array<{ inputId: string; status: string }> };
async function fixture(seed?: "completed" | "cancelled" | "paused" | "needs_confirmation", hold = false) {
  const routed: Snapshot[] = [];
  const main: Wire[] = [];
  const entered = latch(); const held = latch();
  const f = await assistantFixture(async (wire, response) => {
    if ((wire as Wire & { model: string }).model === "router") {
      const snapshot = JSON.parse(String(wire.messages.at(-1)!.content)) as Snapshot;
      routed.push(snapshot);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ actions: [{ kind: "request", text: snapshot.current.text }] }) }, finish_reason: "stop" }] }));
      return;
    }
    main.push(wire);
    if (hold && main.length === 1) { entered.release(); await held.promise; }
    sendChatCompletion(response, "completed");
  }, async (cwd) => {
    if (seed) {
      const dataDir = join(cwd, "fresh");
      await mkdir(dataDir, { recursive: true });
      const queue = new PersistentAssistantQueue(join(dataDir, "queue.sqlite"));
      try {
        const receipt = queue.receive({ conversationId: "one", inputId: "seed", text: "earlier task" });
        if (seed === "cancelled") queue.cancelWork(receipt.eventId);
        else queue.settle(queue.claim("one")!.id, seed);
      } finally { queue.close(); }
    }
    return { intent: { model: "router" }, modelConfiguration: { defaultModel: "local", models: [
      { alias: "local", model: "local", api: "openai-completions", apiKey: "test", baseUrl: "" },
      { alias: "router", model: "router", api: "openai-completions", apiKey: "test", baseUrl: "" },
    ] } };
  });
  return { ...f, get app() { return f.app; }, routed, main, entered, held };
}

for (const seed of [undefined, "completed", "cancelled"] as const) {
  test(`idle input bypasses the classifier with ${seed ?? "no"} history, including after reopening`, async () => {
    const f = await fixture(seed);
    const input = { conversationId: "one", inputId: "new", text: "a fresh question", replyToInputId: "seed" };
    try {
      await f.app.receive(input); await f.app.waitForIdle();
      assert.equal(f.routed.length, 0);
      assert.equal(f.main.length, 1);
      assert.doesNotMatch(JSON.stringify(f.main[0]!.messages), /路由未判定原因/);
      await f.reopen();
      assert.equal((await f.app.receive(input)).duplicate, true);
      await f.app.receive({ ...input, inputId: "next", text: "another fresh question" }); await f.app.waitForIdle();
      assert.equal(f.routed.length, 0); assert.equal(f.main.length, 2);
      assert.equal(f.app.routingStatus("one").works.filter(work => work.inputId === "new").length, 1);
    } finally { await f.close(); }
  });
}

for (const seed of ["paused", "needs_confirmation"] as const) {
  test(`${seed} work still sends the following message through classification`, async () => {
    const f = await fixture(seed);
    try {
      await f.app.receive({ conversationId: "one", inputId: "new", text: "change the earlier task" }); await f.app.waitForIdle();
      assert.equal(f.routed.length, 1);
      assert.ok(f.routed[0]!.works.some(work => work.inputId === "seed" && work.status === seed));
    } finally { await f.close(); }
  });
}

test("back-to-back input routes against preceding work while a different idle conversation bypasses", async () => {
  const f = await fixture(undefined, true);
  try {
    await f.app.receive({ conversationId: "one", inputId: "first", text: "generate report" });
    await f.app.receive({ conversationId: "one", inputId: "second", text: "change report to CSV" });
    await f.entered.promise; await f.app.waitForRouting();
    assert.deepEqual(f.routed.map(snapshot => snapshot.current.inputId), ["second"]);
    assert.ok(f.routed[0]!.works.some(work => work.inputId === "first" && ["running", "queued"].includes(work.status)));
    await f.app.receive({ conversationId: "other", inputId: "third", text: "independent question" });
    await f.app.waitForRouting();
    assert.equal(f.routed.length, 1);
    f.held.release(); await f.app.waitForIdle();
  } finally { f.held.release(); await f.close(); }
});
