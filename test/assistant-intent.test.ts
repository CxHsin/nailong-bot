import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { createIntentClassifier } from "../src/assistant/intent.js";
import type { ModelConfiguration } from "../src/agent/model-config.js";
import { estimateInput } from "../src/context/input-budget.js";

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
    assert.equal(f.requests[0]!.response_format, undefined); assert.equal(f.requests[0]!.chat_template_kwargs, undefined);
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
    { actions: [{ kind: "request", target: "report", text: "cancel report" }] },
    { actions: [{ kind: "supplement", target: "report", candidates: ["report"], text: "cancel report" }] },
  ];
  for (const decision of invalid) {
    const f = await provider((_wire, response) => complete(response, decision));
    try {
      const result = await createIntentClassifier(f.configuration, { model: "fast" }).classify({ input: { conversationId: "one", inputId: "new", text: "cancel report" }, works: [{ id: "report", summary: "report", status: "queued" }], recent: [] });
      assert.deepEqual(result.actions, []); assert.equal(result.reason, "invalid_result");
    } finally { await f.close(); }
  }
});

test("historical candidates cannot consume current identities or their goal summaries", async () => {
  const f = await provider((_wire, response) => complete(response, { actions: [{ kind: "supplement", target: "current", text: "change current goal" }] }));
  try {
    const result = await createIntentClassifier(f.configuration, { model: "fast", inputTokens: 2200 }).classify({
      input: { conversationId: "one", inputId: "new", text: "change current goal" },
      works: [
        ...Array.from({ length: 180 }, (_, index) => ({ id: `history-${index}`, summary: "historical goal ".repeat(80), status: "helper_result", historical: true })),
        { id: "current", summary: "current goal", status: "helper" },
      ], recent: [],
    });
    assert.equal(result.actions[0]?.target, "current");
    const sent = JSON.parse(f.requests[0]!.messages[1].content);
    assert.equal(sent.works[0].id, "current");
    assert.equal(sent.works[0].summary, "current goal");
    assert.equal(sent.incomplete, true, "omitted relevant candidates still prevent global uniqueness assumptions");
  } finally { await f.close(); }
});

test("Cloudflare routing sends model-specific thinking controls and strict action shapes on the actual wire", async () => {
  const f = await provider((_wire, response) => complete(response, { actions: [{ kind: "request", text: "hello" }], reason: "" }));
  const originalFetch = globalThis.fetch;
  const local = f.configuration.models[1]!.baseUrl;
  globalThis.fetch = (_url, init) => originalFetch(`${local}/chat/completions`, init);
  try {
    for (const model of ["@cf/qwen/qwen3-30b-a3b-fp8", "@cf/zai-org/glm-4.7-flash"]) {
      const configuration = { ...f.configuration, models: [{ ...f.configuration.models[1]!, model, reasoning: true, baseUrl: "https://api.cloudflare.com/client/v4/accounts/fixture/ai/v1/" }] };
      const result = await createIntentClassifier(configuration, { model: "fast" }).classify({ input: { conversationId: "one", inputId: "new", text: "hello" }, works: [], recent: [] });
      assert.equal(result.actions[0]?.kind, "request");
      const wire = f.requests.at(-1)!;
      assert.equal(wire.reasoning_effort, undefined); assert.equal(wire.stream, false); assert.equal(wire.tools, undefined);
      assert.equal(wire.response_format.type, "json_schema"); assert.equal(wire.response_format.json_schema.strict, true);
      const schema = wire.response_format.json_schema.schema;
      assert.equal(schema.additionalProperties, false);
      const shapes = schema.properties.actions.items.anyOf;
      assert.deepEqual(shapes.map((shape: any) => shape.required), [["kind", "text"], ["kind", "text", "target"], ["kind", "text", "candidates"]]);
      assert.ok(shapes.every((shape: any) => shape.additionalProperties === false));
      const content = wire.messages[1].content as string;
      if (model.includes("qwen")) {
        assert.equal(wire.chat_template_kwargs, undefined); assert.ok(content.endsWith("\n/no_think"));
        assert.equal(JSON.parse(content.slice(0, -"\n/no_think".length)).current.text, "hello");
      } else {
        assert.deepEqual(wire.chat_template_kwargs, { enable_thinking: false }); assert.equal(JSON.parse(content).current.text, "hello");
      }
    }
    const otherEndpoint = { ...f.configuration, models: [{ ...f.configuration.models[1]!, model: "@cf/qwen/qwen3-30b-a3b-fp8", reasoning: true }] };
    await createIntentClassifier(otherEndpoint, { model: "fast" }).classify({ input: { conversationId: "one", inputId: "new", text: "hello" }, works: [], recent: [] });
    const wire = f.requests.at(-1)!;
    assert.equal(wire.response_format, undefined); assert.equal(wire.reasoning_effort, "low");
    assert.equal(JSON.parse(wire.messages[1].content).current.text, "hello");
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test("Cloudflare schema overhead is charged to the input budget before sending a request", async () => {
  const f = await provider((_wire, response) => complete(response, { actions: [{ kind: "request", text: "hello" }], reason: "" }));
  const originalFetch = globalThis.fetch;
  const local = f.configuration.models[1]!.baseUrl;
  globalThis.fetch = (_url, init) => originalFetch(`${local}/chat/completions`, init);
  const configuration = { ...f.configuration, models: [{ ...f.configuration.models[1]!, model: "@cf/qwen/qwen3-30b-a3b-fp8", baseUrl: "https://api.cloudflare.com/client/v4/accounts/fixture/ai/v1" }] };
  const request = { input: { conversationId: "one", inputId: "new", text: "hello" }, works: [], recent: [] };
  try {
    await createIntentClassifier(configuration, { model: "fast" }).classify(request);
    const wire = f.requests[0]!;
    const promptTokens = estimateInput({ systemPrompt: wire.messages[0].content, messages: [{ role: "user", content: wire.messages[1].content, timestamp: 0 }] });
    const inputTokens = promptTokens + 4;
    const rejected = await createIntentClassifier(configuration, { model: "fast", inputTokens }).classify(request);
    assert.equal(rejected.reason, "input_budget"); assert.equal(f.requests.length, 1);
    const ordinary = await createIntentClassifier(f.configuration, { model: "fast", inputTokens }).classify(request);
    assert.equal(ordinary.actions[0]?.kind, "request"); assert.equal(f.requests.length, 2);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test("reasoning-only JSON cannot become a control decision", async () => {
  const f = await provider((_wire, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: null, reasoning: '{"actions":[{"kind":"cancel","text":"cancel","target":"report"}]}' } }] }));
  });
  try {
    const result = await createIntentClassifier(f.configuration, { model: "fast" }).classify({ input: { conversationId: "one", inputId: "new", text: "cancel" }, works: [{ id: "report", summary: "report", status: "queued" }], recent: [] });
    assert.deepEqual(result.actions, []); assert.equal(result.reason, "invalid_result");
  } finally { await f.close(); }
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

test("routing retains assistant-only context and reply information on the actual model request", async () => {
  const f = await provider((_wire, response) => complete(response, { actions: [{kind: "supplement", text: "只保留金额列。", target: "report"}] }));
  try {
    const classifier = createIntentClassifier(f.configuration, {model: "fast"});
    const input = {conversationId: "one", inputId: "current", text: "只保留金额列。", replyToMessageId: "123", replyToInputId: "original",
      replyToMessage: {role: "assistant" as const, text: "报表已生成，包含日期和金额两列。", hasImages: false}};
    const recent = [{role: "assistant" as const, text: "季度图表已开始生成。", inputId: "assistant:earlier"}];
    const result = await classifier.classify({input, recent, works: [{id: "report", summary: "生成销售报表", status: "running"}], replyTargets: ["report"]});
    assert.equal(result.actions[0]?.target, "report");
    const sent = JSON.parse(f.requests[0]!.messages[1].content);
    assert.deepEqual(sent.recent, recent);
    assert.deepEqual(sent.current.replyToMessage, input.replyToMessage);
    assert.equal(sent.current.replyToMessageId, "123"); assert.equal(sent.current.replyToInputId, "original");
    assert.deepEqual(sent.replyTargets, ["report"]); assert.equal(sent.works[0].summary, "生成销售报表");
    const mixed = [recent[0]!, {role: "user" as const, inputId: "prior", text: "保持金额列"}, {role: "assistant" as const, inputId: "answer", text: "已确认"}];
    await classifier.classify({input, recent: mixed, works: [{id: "report", summary: "生成销售报表", status: "running"}]});
    assert.deepEqual(JSON.parse(f.requests[1]!.messages[1].content).recent, mixed);
    const over = await classifier.classify({input: {...input, replyToMessage: {...input.replyToMessage, text: "原文".repeat(9000)}}, recent, works: []});
    assert.equal(over.reason, "input_budget"); assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test("bounded routing keeps work goals and a consecutive recent suffix without backfilling older dialogue", async () => {
  const f = await provider((_wire, response) => complete(response, {actions: [{kind: "request", text: "continue"}]}));
  try {
    const classifier = createIntentClassifier(f.configuration, {model: "fast", inputTokens: 2200, recentTurns: 2});
    const request = {input: {conversationId: "one", inputId: "current", text: "continue"}, works: [{id: "report", summary: "生成销售报表", status: "running"}], recent: [
      {role: "user" as const, inputId: "old", text: "OLDER_SMALL"},
      {role: "user" as const, inputId: "large", text: "超".repeat(9000)},
      {role: "user" as const, inputId: "last", text: "LATEST"},
      {role: "assistant" as const, inputId: "answer", text: "CONFIRMED"},
    ]};
    await classifier.classify(request);
    const sent = JSON.parse(f.requests[0]!.messages[1].content);
    assert.equal(sent.works[0].summary, "生成销售报表");
    assert.deepEqual(sent.recent, request.recent.slice(-2));
    await createIntentClassifier(f.configuration, {model: "fast", inputTokens: 2200, recentTurns: 3}).classify(request);
    assert.deepEqual(JSON.parse(f.requests[1]!.messages[1].content).recent, request.recent.slice(-2));
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
