import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";
import { Type } from "typebox";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function eventText(wire: { messages: Array<{ role: string; content: unknown }> }) {
  return wire.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join("\n");
}

async function routedFixture(provider: Parameters<typeof assistantFixture>[0], configure?: Parameters<typeof assistantFixture>[1]) {
  return assistantFixture((wire, response) => {
    if ((wire as typeof wire & { model: string }).model !== "router") return provider(wire, response);
    const context = JSON.parse(String(wire.messages.at(-1)!.content)) as { current: { text: string }; works: Array<{ id: string; status: string }> };
    const text = context.current.text;
    const target = context.works.find((work) => work.status === "running");
    const actions = /^(?:supplement |explicit final-boundary)/.test(text) && target ? [{ kind: "supplement", text, target: target.id }] : [{ kind: "request", text }];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ actions }) }, finish_reason: "stop" }] }));
  }, async (cwd) => ({
    ...await configure?.(cwd), intent: { model: "router" }, modelConfiguration: { defaultModel: "local", models: [
      { alias: "local", model: "local", api: "openai-completions", apiKey: "test", baseUrl: "" },
      { alias: "router", model: "router", api: "openai-completions", apiKey: "test", baseUrl: "" },
    ] },
  }));
}

test("ordinary direct inputs wait, then the existing consecutive messages share the next turn", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const requests: string[] = [];
  const f = await assistantFixture(async (wire, response) => {
    requests.push(JSON.stringify(wire.messages));
    if (requests.length === 1) {
      entered();
      await held;
      sendChatCompletion(response, "A finished");
    } else {
      assert.match(JSON.stringify(wire.messages.at(-1)), /message B/);
      assert.match(JSON.stringify(wire.messages.at(-1)), /message C/);
      sendChatCompletion(response, "B and C handled");
    }
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "a", text: "message A" });
    await ready;
    await f.app.receive({ conversationId: "one", inputId: "b", text: "message B" });
    await f.app.receive({ conversationId: "one", inputId: "c", text: "message C" });
    release();
    await f.app.waitForIdle();
    assert.equal(requests.length, 2);
    assert.deepEqual(f.outputs.flatMap((out) => out.type === "text" ? [out.text] : []), ["A finished", "B and C handled"]);
  } finally { release(); await f.close(); }
});

test("natural-language Telegram supplements join the supported tool boundary once, while ordinary input waits", { timeout: 60_000 }, async () => {
  const entered = latch();
  const held = latch();
  const requests: string[] = [];
  let toolCalls = 0;
  const f = await routedFixture((wire, response) => {
    requests.push(eventText(wire));
    if (requests.length === 1) sendChatCompletion(response, "", [{ index: 0, id: "held-tool", type: "function",
      function: { name: "hold_work", arguments: "{}" } }]);
    else if (requests.length === 2) sendChatCompletion(response, "current work and supplements finished");
    else sendChatCompletion(response, "ordinary input finished");
  }, async () => ({ tools: [{ name: "hold_work", label: "hold", description: "Wait at an observable tool boundary", parameters: Type.Object({}),
    async execute() { toolCalls++; entered.release(); await held.promise; return { content: [{ type: "text" as const, text: "tool completed" }], details: {} }; } }] }));
  const conversationId = "telegram:private:42";
  try {
    await f.app.receive({ conversationId, source: "telegram", inputId: "start", text: "start current work" });
    await entered.promise;
    await f.app.receive({ conversationId, source: "telegram", inputId: "ordinary", text: "ordinary later work" });
    await f.app.receive({ conversationId, source: "telegram", inputId: "s-one", text: "supplement alpha" });
    await f.app.receive({ conversationId, source: "telegram", inputId: "s-two", text: "supplement beta" });
    await f.app.receive({ conversationId, source: "telegram", inputId: "s-one", text: "supplement alpha" });
    await f.app.waitForRouting();
    assert.equal(requests.length, 1, "supplement receipt must not interrupt the running tool");
    held.release();
    await f.app.waitForIdle();
    assert.equal(toolCalls, 1);
    assert.equal(requests.length, 3);
    assert.match(requests[1]!, /s-one/);
    assert.match(requests[1]!, /s-two/);
    assert.equal((requests[1]!.match(/<event identity=\\"s-one\\"/g) ?? []).length, 1);
    assert.equal((requests[1]!.match(/<event identity=\\"s-two\\"/g) ?? []).length, 1);
    assert.ok(requests[1]!.indexOf("supplement alpha") < requests[1]!.indexOf("supplement beta"));
    assert.doesNotMatch(requests[1]!, /ordinary later work/);
    assert.match(requests[2]!, /ordinary later work/);
    await f.app.receive({ conversationId, source: "telegram", inputId: "s-one", text: "supplement alpha" });
    await f.app.waitForIdle();
    assert.equal(requests.length, 3, "a handled steering identity remains deduplicated");
  } finally { held.release(); await f.close(); }
});

test("a natural-language supplement arriving before a final response is retained for a later run, with one delivery per identity", { timeout: 60_000 }, async () => {
  const entered = latch();
  const held = latch();
  const requests: string[] = [];
  const f = await routedFixture(async (wire, response) => {
    requests.push(eventText(wire));
    if (requests.length === 1) { entered.release(); await held.promise; sendChatCompletion(response, "original final answer"); }
    else sendChatCompletion(response, "late supplement handled");
  });
  const conversationId = "telegram:private:42";
  try {
    await f.app.receive({ conversationId, inputId: "initial", text: "ordinary original" });
    await entered.promise;
    await f.app.receive({ conversationId, inputId: "late", text: "explicit final-boundary supplement" });
    await f.app.receive({ conversationId, inputId: "late", text: "explicit final-boundary supplement" });
    await f.app.waitForRouting();
    held.release(); await f.app.waitForIdle();
    assert.equal(requests.length, 2);
    assert.equal((requests[1]!.match(/<event identity=\\"late\\"/g) ?? []).length, 1);
    assert.match(requests[1]!, /explicit final-boundary supplement/);
    assert.deepEqual(f.outputs.flatMap((output) => output.type === "text" ? [output.text] : []), ["original final answer", "late supplement handled"]);
  } finally { held.release(); await f.close(); }
});

test("idle natural-language input remains intact and duplicate receipt does not repeat it", { timeout: 60_000 }, async () => {
  const requests: string[] = [];
  const f = await routedFixture((wire, response) => { requests.push(eventText(wire)); sendChatCompletion(response, "idle supplement handled"); });
  try {
    const input = { conversationId: "telegram:private:42", source: "telegram", inputId: "idle", text: "idle supplement" };
    await f.app.receive(input); await f.app.waitForIdle();
    await f.app.receive(input);
    await f.app.waitForIdle();
    assert.equal(requests.length, 1);
    assert.match(requests[0]!, /idle supplement/);
  } finally { await f.close(); }
});

test("an idle input receipt remains deduplicated when its repeated delivery arrives during later work", { timeout: 60_000 }, async () => {
  const entered = latch();
  const held = latch();
  let requests = 0;
  const f = await routedFixture(async (_wire, response) => {
    requests++;
    if (requests === 2) { entered.release(); await held.promise; }
    sendChatCompletion(response, `answer-${requests}`);
  });
  try {
    const input = { conversationId: "telegram:private:42", source: "telegram", inputId: "once-idle", text: "original idle input" };
    await f.app.receive(input); await f.app.waitForIdle();
    await f.app.receive({ ...input, inputId: "new-work", text: "later ordinary work" });
    await entered.promise;
    await f.app.receive(input);
    held.release(); await f.app.waitForIdle();
    assert.equal(requests, 2, "a source identity accepted as ordinary input cannot become a new steering submission on redelivery");
  } finally { held.release(); await f.close(); }
});

test("reset is a batch barrier that preserves queued input while clearing earlier main context", { timeout: 60_000 }, async () => {
  const entered = latch();
  const held = latch();
  const requests: string[] = [];
  const f = await assistantFixture(async (wire, response) => {
    requests.push(eventText(wire));
    if (requests.length === 1) { entered.release(); await held.promise; }
    sendChatCompletion(response, `answer-${requests.length}`);
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "a", text: "old-context A" });
    await entered.promise;
    await f.app.receive({ conversationId: "one", inputId: "b", text: "before reset B" });
    await f.app.receive({ conversationId: "one", inputId: "reset", text: "/reset" });
    await f.app.receive({ conversationId: "one", inputId: "c", text: "after reset C" });
    await f.app.receive({ conversationId: "one", inputId: "d", text: "after reset D" });
    held.release(); await f.app.waitForIdle();
    assert.equal(requests.length, 3);
    assert.match(requests[1]!, /before reset B/);
    assert.doesNotMatch(requests[1]!, /after reset/);
    assert.match(requests[2]!, /after reset C/);
    assert.match(requests[2]!, /after reset D/);
    assert.doesNotMatch(requests[2]!, /old-context A|before reset B|\/reset/);
    const resetIndex = f.outputs.findIndex((output) => output.type === "text" && /已重置/.test(output.text));
    assert.ok(resetIndex > f.outputs.findIndex((output) => output.type === "text" && output.text === "answer-2"));
    assert.ok(resetIndex < f.outputs.findIndex((output) => output.type === "text" && output.text === "answer-3"));
  } finally { held.release(); await f.close(); }
});
