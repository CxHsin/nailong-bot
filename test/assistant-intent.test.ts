import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { createIntentClassifier } from "../src/assistant/intent.js";
import type { ModelConfiguration } from "../src/agent/model-config.js";

async function provider(reply: (wire: Record<string, any>, response: ServerResponse) => void) {
  const requests: Record<string, any>[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    const wire = JSON.parse(body); requests.push(wire); reply(wire, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  const configuration: ModelConfiguration = { defaultModel: "main", models: [
    { alias: "main", model: "main", api: "openai-completions", apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}` },
    { alias: "fast", model: "fast", api: "openai-completions", apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}` },
  ] };
  return { configuration, requests, async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
function complete(response: ServerResponse, result: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: "fixture", object: "chat.completion", created: 0, model: "fast", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(result) }, finish_reason: "stop" }] }));
}

test("classifier uses its configured alias with a tool-free nonstream request and preserves ordered original spans", async () => {
  const actions = [{ kind: "cancel", target: "report", text: "cancel report" }, { kind: "request", text: "tell me weather" }];
  const f = await provider((_wire, response) => complete(response, { actions }));
  try {
    const classifier = createIntentClassifier(f.configuration, { model: "fast" });
    const result = await classifier.classify({ input: { conversationId: "one", inputId: "new", text: "cancel report; tell me weather" }, works: [{ id: "report", summary: "report", status: "queued", inputId: "old" }], recent: [{ role: "user", inputId: "old", text: "make a report" }] });
    assert.deepEqual(result.actions, actions);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.model, "fast");
    assert.equal(f.requests[0]!.stream, false); assert.equal(f.requests[0]!.tools, undefined);
    assert.equal(f.requests[0]!.max_tokens, 1024);
    assert.match(JSON.stringify(f.requests[0]!.messages), /make a report/);
  } finally { await f.close(); }
});

test("an invalid action invalidates the whole decision before any control is exposed", async () => {
  const invalid = [
    { actions: [{ kind: "cancel", target: "report", text: "cancel" }, { kind: "cancel", target: "invented", text: "report" }] },
    { actions: [{ kind: "delete", target: "report", text: "cancel report" }] },
    { actions: [{ kind: "supplement", text: "cancel report" }] },
    { actions: [{ kind: "cancel", target: "report", text: "rewritten text" }] },
    { actions: [{ kind: "clarify", text: "cancel report", candidates: ["invented"] }] },
    { actions: [{ kind: "request", text: "report" }, { kind: "cancel", target: "report", text: "cancel" }] },
    { actions: [{ kind: "cancel", target: "report", text: "cancel" }, { kind: "cancel", target: "report", text: "cancel" }] },
  ];
  for (const decision of invalid) {
    const f = await provider((_wire, response) => complete(response, decision));
    try {
      const result = await createIntentClassifier(f.configuration, { model: "fast" }).classify({ input: { conversationId: "one", inputId: "new", text: "cancel report" }, works: [{ id: "report", summary: "report", status: "queued" }], recent: [] });
      assert.deepEqual(result.actions, []); assert.equal(result.reason, "invalid_result");
    } finally { await f.close(); }
  }
});

test("the input budget preserves current text and reply identities while marking omitted candidates", async () => {
  const f = await provider((_wire, response) => complete(response, { actions: [{ kind: "supplement", target: "reply", text: "change reply" }] }));
  try {
    const classifier = createIntentClassifier(f.configuration, { model: "fast", inputTokens: 2200, recentTurns: 1 });
    const input = { conversationId: "one", inputId: "new", text: "change reply" };
    const works = [{ id: "reply", summary: "reply", status: "queued" }, ...Array.from({ length: 90 }, (_, i) => ({ id: `work-${i}`, summary: "中".repeat(1000), status: "queued" }))];
    const request = { input, works, replyTargets: ["reply"], recent: [{ role: "user" as const, inputId: "old", text: "old-turn" }, { role: "user" as const, inputId: "latest", text: "latest-turn" }, { role: "assistant" as const, inputId: "assistant:latest", text: "confirmed-answer" }] };
    const first = await classifier.classify(request); const second = await classifier.classify(request);
    assert.deepEqual(first.snapshot, second.snapshot);
    const snapshot = first.snapshot as { current: { text: string }; works: Array<{ id: string; summary: string }>; recent: Array<{ text: string }>; incomplete: boolean };
    assert.equal(snapshot.current.text, input.text); assert.equal(snapshot.works[0]!.id, "reply"); assert.equal(snapshot.incomplete, true);
    assert.ok(snapshot.works.every((work) => [...work.summary].length <= 512));
    assert.equal(snapshot.recent.some((item) => item.text === "old-turn"), false);
    const recent = await classifier.classify({ ...request, works: [works[0]!] });
    assert.match(JSON.stringify(recent.snapshot), /confirmed-answer/);
    assert.doesNotMatch(JSON.stringify(recent.snapshot), /old-turn/);
    const over = await classifier.classify({ input: { ...input, text: "超".repeat(9000) }, works: [], recent: [] });
    assert.equal(over.reason, "input_budget"); assert.deepEqual(over.actions, []); assert.equal(f.requests.length, 3);
  } finally { await f.close(); }
});

test("an incomplete candidate list cannot authorize cancellation by uniqueness", async () => {
  const f = await provider((_wire, response) => complete(response, { actions: [{ kind: "cancel", target: "report", text: "cancel that" }] }));
  try {
    const result = await createIntentClassifier(f.configuration, { model: "fast" }).classify({ input: { conversationId: "one", inputId: "new", text: "cancel that" }, works: [{ id: "report", summary: "quarterly report", status: "queued" }], recent: [], incomplete: true });
    assert.deepEqual(result.actions, []); assert.equal(result.reason, "incomplete_target");
  } finally { await f.close(); }
});

test("timeouts and provider failures degrade once without returning late control actions", async () => {
  const timeout = await provider((_wire, response) => { setTimeout(() => complete(response, { actions: [{ kind: "cancel", text: "cancel", target: "report" }] }), 100).unref(); });
  try {
    const result = await createIntentClassifier(timeout.configuration, { model: "fast", timeoutMs: 20 }).classify({ input: { conversationId: "one", inputId: "new", text: "cancel" }, works: [{ id: "report", summary: "report", status: "queued" }], recent: [] });
    assert.deepEqual(result.actions, []); assert.equal(result.reason, "timeout"); assert.equal(timeout.requests.length, 1);
  } finally { await timeout.close(); }
  const failure = await provider((_wire, response) => { response.writeHead(503); response.end("unavailable"); });
  try {
    const result = await createIntentClassifier(failure.configuration, { model: "fast" }).classify({ input: { conversationId: "one", inputId: "new", text: "hello" }, works: [], recent: [] });
    assert.deepEqual(result.actions, []); assert.equal(result.reason, "classifier_error"); assert.equal(failure.requests.length, 1);
  } finally { await failure.close(); }
});

test("configuration errors fail at startup while missing configuration and image-only inputs retain a fallback reason", async () => {
  const f = await provider((_wire, response) => complete(response, { actions: [{ kind: "request", text: "look" }] }));
  const request = { input: { conversationId: "one", inputId: "new", text: "look" }, works: [], recent: [] };
  try {
    assert.throws(() => createIntentClassifier(f.configuration, { model: "missing" }), /分类模型/);
    assert.throws(() => createIntentClassifier(f.configuration, { model: "fast", timeoutMs: 0 }), /正整数/);
    assert.throws(() => createIntentClassifier(f.configuration, { model: "fast", outputTokens: 20000 }), /窗口/);
    assert.throws(() => createIntentClassifier(f.configuration, { model: "fast", inputTokens: 128000 }), /窗口/);
    const missing = await createIntentClassifier(f.configuration).classify(request); assert.equal(missing.reason, "not_configured");
    const visual = await createIntentClassifier(f.configuration, { model: "fast" }).classify({ ...request, input: { ...request.input, userText: "", images: [{ type: "image", data: "photo", mimeType: "image/png" }] } });
    assert.equal(visual.reason, "needs_visual"); assert.deepEqual(visual.actions, []); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});
