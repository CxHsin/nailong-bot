import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { IntentOptions } from "../src/assistant/intent.js";
import { assistantFixture, seedPendingAssistantWork, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

type Snapshot = { current: { conversationId: string; inputId: string; text: string }; works: Array<{ id: string; inputId: string; summary: string; status: string }>; recent: unknown[] };
function latch() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
function decision(response: ServerResponse, actions: unknown[]) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ actions }) }, finish_reason: "stop" }] }));
}
function text(wire: Wire) {
  return wire.messages.map((message) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") : "").join("\n");
}
async function routingFixture(router: (snapshot: Snapshot, response: ServerResponse) => void | Promise<void>, main: Parameters<typeof assistantFixture>[0], options: IntentOptions = {}, pendingWork = false) {
  const snapshots: Snapshot[] = [];
  const f = await assistantFixture((wire, response) => {
    if ((wire as Wire & { model: string }).model !== "router") return main(wire, response);
    const snapshot = JSON.parse(String(wire.messages.at(-1)!.content)) as Snapshot; snapshots.push(snapshot); return router(snapshot, response);
  }, async (cwd) => { if (pendingWork) await seedPendingAssistantWork(cwd, "one"); return { intent: { model: "router", ...options }, modelConfiguration: { defaultModel: "local", models: [
    { alias: "local", model: "local", api: "openai-completions", apiKey: "test", baseUrl: "" },
    { alias: "router", model: "router", api: "openai-completions", apiKey: "test", baseUrl: "" },
  ] } }; });
  return { ...f, get app() { return f.app; }, snapshots };
}

test("classifier failure and timeout preserve raw input without accepting a late cancellation", { timeout: 60_000 }, async () => {
  for (const failure of ["provider", "timeout"] as const) {
    const entered = latch(); const held = latch(); const late = latch(); const lateSent = latch(); const main: string[] = [];
    const f = await routingFixture(async (snapshot, response) => {
      if (snapshot.current.text !== "cancel original") return decision(response, [{ kind: "request", text: snapshot.current.text }]);
      if (failure === "provider") { response.writeHead(503); response.end("unavailable"); return; }
      await late.promise;
      decision(response, [{ kind: "cancel", text: "cancel original", target: snapshot.works.find((work) => work.inputId === "original")!.id }]); lateSent.release();
    }, async (wire, response) => {
      main.push(text(wire));
      if (main.length === 1) { entered.release(); await held.promise; }
      sendChatCompletion(response, main.length === 1 ? "original completed" : "fallback examined");
    }, { timeoutMs: 100 });
    try {
      await f.app.receive({ conversationId: "one", inputId: "original", text: "do original" }); await entered.promise;
      await f.app.receive({ conversationId: "one", inputId: "cancel", text: "cancel original" }); await f.app.waitForRouting();
      if (failure === "timeout") { late.release(); await lateSent.promise; }
      assert.equal(main.length, 1);
      held.release(); await f.app.waitForIdle();
      assert.equal(main.length, 2); assert.ok(main[1]!.includes("cancel original"));
      assert.match(main[1]!, failure === "timeout" ? /timeout/ : /classifier_error/);
      assert.equal(f.app.routingStatus("one").works.find((work) => work.inputId === "original")!.status, "completed");
      assert.deepEqual(f.outputs.flatMap((output) => output.type === "text" ? [output.text] : []), ["original completed", "fallback examined"]);
    } finally { held.release(); late.release(); await f.close(); }
  }
});

test("invalid composite decisions preserve queued work before exposing any cancellation", { timeout: 60_000 }, async () => {
  const entered = latch(); const held = latch(); const main: string[] = [];
  const f = await routingFixture((snapshot, response) => {
    const current = snapshot.current.text;
    if (current === "cancel report; cancel invented") return decision(response, [
      { kind: "cancel", text: "cancel report", target: snapshot.works.find((work) => work.inputId === "report")!.id },
      { kind: "cancel", text: "cancel invented", target: "invented" },
    ]);
    decision(response, [{ kind: "request", text: current }]);
  }, async (wire, response) => {
    main.push(text(wire)); if (main.length === 1) { entered.release(); await held.promise; }
    sendChatCompletion(response, "completed");
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "busy", text: "busy work" }); await entered.promise;
    await f.app.receive({ conversationId: "one", inputId: "report", text: "generate report" });
    await f.app.receive({ conversationId: "one", inputId: "invalid", text: "cancel report; cancel invented" }); await f.app.waitForRouting();
    assert.equal(f.app.routingStatus("one").works.find((work) => work.inputId === "report")!.status, "queued");
    held.release(); await f.app.waitForIdle();
    assert.ok(main.slice(1).some((request) => request.includes("generate report")));
    assert.ok(main.slice(1).some((request) => request.includes("cancel report; cancel invented") && request.includes("invalid_result")));
    assert.equal(f.app.routingStatus("one").works.find((work) => work.inputId === "report")!.status, "completed");
    assert.ok(!f.outputs.some((output) => output.type === "text" && /已取消|已请求停止/.test(output.text)));
  } finally { held.release(); await f.close(); }
});

test("an overbudget current input reaches the main assistant intact without a truncated classifier call", { timeout: 60_000 }, async () => {
  const main: string[] = [];
  const f = await routingFixture((_snapshot, response) => decision(response, []), (wire, response) => { main.push(text(wire)); sendChatCompletion(response, "full input examined"); }, { inputTokens: 1000 }, true);
  try {
    const original = "Do not cancel any work: " + "完整限定条件".repeat(900) + " END_NEGATION_DO_NOT_CANCEL";
    await f.app.receive({ conversationId: "one", inputId: "large", text: original }); await f.app.waitForIdle();
    assert.equal(f.snapshots.length, 0); assert.equal(main.length, 1);
    assert.ok(main[0]!.includes(original)); assert.match(main[0]!, /input_budget/);
    assert.equal(f.app.routingStatus("one").works.find((work) => work.inputId === "large")!.input.text, original);
  } finally { await f.close(); }
});

test("source deduplication is per conversation and a foreign cancellation cannot control local work", { timeout: 60_000 }, async () => {
  const entered = latch(); const held = latch(); const main: string[] = []; let foreign = "";
  const f = await routingFixture((snapshot, response) => {
    if (snapshot.current.text === "cancel A") return decision(response, [{ kind: "cancel", text: "cancel A", target: foreign }]);
    decision(response, [{ kind: "request", text: snapshot.current.text }]);
  }, async (wire, response) => {
    main.push(text(wire)); if (main.length === 2) { entered.release(); await held.promise; }
    sendChatCompletion(response, "completed");
  });
  try {
    const a = { conversationId: "a", source: "telegram", inputId: "shared-id", text: "A_PRIVATE work" };
    const b = { conversationId: "b", source: "telegram", inputId: "shared-id", text: "B_PRIVATE work" };
    await f.app.receive(a); await f.app.waitForIdle();
    foreign = f.app.routingStatus("a").works[0]!.id;
    await f.app.receive(b); await entered.promise;
    await f.app.receive({ conversationId: "b", source: "telegram", inputId: "cancel", text: "cancel A" }); await f.app.waitForRouting();
    const snapshot = f.snapshots.find((entry) => entry.current.inputId === "cancel")!;
    assert.equal(snapshot.current.conversationId, "b"); assert.ok(snapshot.works.every((work) => work.id !== foreign));
    assert.doesNotMatch(JSON.stringify(snapshot), /A_PRIVATE/);
    assert.equal(f.app.routingStatus("b").works.find((work) => work.inputId === "shared-id")!.status, "running");
    await f.app.receive(a); await f.app.receive(b);
    held.release(); await f.app.waitForIdle();
    assert.equal(main.length, 3); assert.match(main[2]!, /cancel A/); assert.match(main[2]!, /invalid_result/);
    assert.equal(f.app.routingStatus("a").works.length, 1);
    assert.equal(f.app.routingStatus("b").works.filter((work) => work.inputId === "shared-id").length, 1);
    assert.ok(f.app.routingStatus("b").works.every((work) => work.status === "completed"));
  } finally { held.release(); await f.close(); }
});

test("forgotten original material and its assistant paraphrase stay out of classifier input after reopening", { timeout: 60_000 }, async () => {
  let phase = "seed"; let sourceId = ""; const main: string[] = [];
  const f = await routingFixture((snapshot, response) => decision(response, [{ kind: "request", text: snapshot.current.text }]), (wire, response) => {
    main.push(text(wire));
    if (phase === "seed") {
      sourceId = main.at(-1)!.match(/sourceId=(source:[a-f0-9]{64})/)?.[1] ?? sourceId;
      return sendChatCompletion(response, "DERIVED_SECRET: the user's long-term beverage preference is Golden infusion.");
    }
    if (phase === "forget" && wire.messages.at(-1)?.role !== "tool") return sendChatCompletion(response, "", [{ index: 0, id: "forget-origin", type: "function", function: { name: "memory_forget", arguments: JSON.stringify({ id: sourceId, expectedVersion: 0 }) } }]);
    sendChatCompletion(response, "completed");
  }, {}, true);
  try {
    await f.app.receive({ conversationId: "one", inputId: "seed", text: "ORIGINAL_SECRET: my breakfast drink is amber flower tea." }); await f.app.waitForIdle(); assert.ok(sourceId);
    phase = "forget";
    await f.app.receive({ conversationId: "one", inputId: "forget", text: "forget that beverage preference" }); await f.app.waitForIdle();
    assert.doesNotMatch(main.at(-1)!, /DERIVED_SECRET/);
    await f.reopen(); phase = "ask";
    await f.app.receive({ conversationId: "one", inputId: "ask", text: "continue with an unrelated weather question" }); await f.app.waitForIdle();
    const snapshot = f.snapshots.find((entry) => entry.current.inputId === "ask")!;
    assert.ok(snapshot); assert.doesNotMatch(JSON.stringify(snapshot), /ORIGINAL_SECRET|DERIVED_SECRET|Golden infusion|amber flower tea/);
    assert.doesNotMatch(main.at(-1)!, /ORIGINAL_SECRET|DERIVED_SECRET/);
  } finally { await f.close(); }
});

test("a supplement whose target finishes during classification becomes a follow-up against confirmed results", { timeout: 60_000 }, async () => {
  const entered = latch(); const held = latch(); const classifying = latch(); const classified = latch(); const finished = latch(); const main: string[] = [];
  const f = await routingFixture(async (snapshot, response) => {
    if (snapshot.current.text === "change report to CSV") {
      const target = snapshot.works.find((work) => work.inputId === "original")!;
      assert.equal(target.status, "running"); classifying.release(); await classified.promise;
      return decision(response, [{ kind: "supplement", text: snapshot.current.text, target: target.id }]);
    }
    decision(response, [{ kind: "request", text: snapshot.current.text }]);
  }, async (wire, response) => {
    main.push(text(wire));
    if (main.length === 1) { entered.release(); await held.promise; }
    sendChatCompletion(response, main.length === 1 ? "confirmed report finished" : "CSV follow-up completed");
  });
  const unsubscribe = f.app.subscribe((output) => { if (output.type === "text" && output.text === "confirmed report finished") finished.release(); });
  try {
    await f.app.receive({ conversationId: "one", inputId: "original", text: "generate report" }); await entered.promise;
    await f.app.receive({ conversationId: "one", inputId: "amend", text: "change report to CSV" }); await classifying.promise;
    held.release(); await finished.promise; await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.app.routingStatus("one").works.find((work) => work.inputId === "original")!.status, "completed");
    classified.release(); await f.app.waitForIdle();
    assert.equal(main.length, 2); assert.match(main[1]!, /change report to CSV/);
    assert.match(main[1]!, /confirmed report finished/); assert.match(main[1]!, /原执行已结束或暂停/);
    assert.deepEqual(f.outputs.flatMap((output) => output.type === "text" ? [output.text] : []), ["confirmed report finished", "CSV follow-up completed"]);
  } finally { unsubscribe(); held.release(); classified.release(); await f.close(); }
});
