import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntentClassifier, type IntentRequest } from "../src/assistant/intent.js";
import { intentEnvironment } from "../src/assistant/environment.js";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

const configuration = { defaultModel: "unused", models: [] };
const clef = { model: "clef-flash" as const, accountId: "fixture-account", apiToken: "fixture-secret" };
const report = { id: "report", summary: "生成本月销售报表", status: "running" };
const chart = { id: "chart", summary: "生成季度收入图表", status: "queued" };
const request: IntentRequest = { input: { conversationId: "one", inputId: "new", text: "只保留金额列。" }, works: [report, chart], recent: [], replyTargets: ["report"] };
type Wire = { state: { works: typeof request.works; incomplete: boolean }; questions: { route: { criteria: Record<string, string> } } };
function answer(wire: Wire, choice: string, confidence = 0.8) {
  return { success: true, result: { answers: { route: { type: "choice", choice, confidence, probabilities: Object.fromEntries(Object.keys(wire.questions.route.criteria).map(key => [key, key === choice ? 0.9 : 0.01])) } } } };
}

test("Clef selects complete actions with reply descriptions and preserves explicit other targets", async t => {
  let chosen = "supplement_0";
  const sent: Wire[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const wire = JSON.parse(String(init.body)) as Wire; sent.push(wire);
    return Response.json(answer(wire, chosen));
  });
  const classifier = createIntentClassifier(configuration, { clef });
  const result = await classifier.classify(request);
  assert.deepEqual(result.actions, [{ kind: "supplement", target: "report", text: request.input.text }]);
  assert.deepEqual(Object.keys(sent[0]!.questions), ["route"]);
  assert.match(sent[0]!.questions.route.criteria.supplement_0!, /verifiedReplyTarget\\?":true/);
  assert.match(sent[0]!.questions.route.criteria.supplement_1!, /verifiedReplyTarget\\?":false/);
  assert.doesNotMatch(JSON.stringify(result.snapshot), /fixture-secret|fixture-account/);
  chosen = "cancel_1";
  const other = await classifier.classify({ ...request, input: { ...request.input, text: "停止季度收入图表。" } });
  assert.deepEqual(other.actions, [{ kind: "cancel", target: "chart", text: "停止季度收入图表。" }]);
});

test("uncertainty clarifies without control; compound and low confidence retain full text", async t => {
  let chosen = "uncertain";
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => Response.json(answer(JSON.parse(String(init.body)), chosen, 0.3)));
  const classifier = createIntentClassifier(configuration, { clef });
  assert.deepEqual((await classifier.classify(request)).actions, [{ kind: "clarify", text: request.input.text, candidates: ["report", "chart"] }]);
  chosen = "compound";
  const compound = await classifier.classify({ ...request, input: { ...request.input, text: "取消图表；再查天气。" } });
  assert.deepEqual(compound.actions, []); assert.equal(compound.reason, "compound");
  chosen = "cancel_0";
  const low = await createIntentClassifier(configuration, { clef: { ...clef, minConfidence: 0.5 } }).classify(request);
  assert.equal(low.reason, "low_confidence"); assert.equal(low.actions[0]?.kind, "clarify");
});

test("Clef rejects unknown choices and malformed decision scores and degrades provider failures once", async t => {
  let mode = "unknown"; let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++;
    const raw = answer(JSON.parse(String(init.body)), mode === "unknown" ? "invented" : "cancel_0");
    if (mode === "confidence") raw.result.answers.route.confidence = 2;
    if (mode === "scores") delete raw.result.answers.route.probabilities.cancel_0;
    if (mode === "failure") return new Response("unavailable", { status: 503 });
    return Response.json(raw);
  });
  for (mode of ["unknown", "confidence", "scores", "failure"]) {
    const result = await createIntentClassifier(configuration, { clef }).classify(request);
    assert.deepEqual(result.actions, []); assert.equal(result.reason, mode === "failure" ? "classifier_error" : "invalid_result");
  }
  assert.equal(calls, 4);
});

test("Clef shares incomplete-target, full-input, reply-budget and option-count protections", async t => {
  const sent: Wire[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const wire = JSON.parse(String(init.body)) as Wire; sent.push(wire); return Response.json(answer(wire, "cancel_0"));
  });
  const classifier = createIntentClassifier(configuration, { clef });
  const incomplete = await classifier.classify({ ...request, input: { ...request.input, text: "那个先别做了。" }, works: [report], replyTargets: [], incomplete: true });
  assert.equal(incomplete.reason, "incomplete_target"); assert.deepEqual(incomplete.actions, []);
  const reply = await classifier.classify({ ...request, incomplete: true });
  assert.equal(reply.actions[0]?.target, "report");
  const count = sent.length;
  const over = await classifier.classify({ ...request, input: { ...request.input, text: "中".repeat(16000) } });
  assert.equal(over.reason, "input_budget"); assert.equal(sent.length, count);
  const image = await classifier.classify({ ...request, input: { ...request.input, text: "default image prompt", userText: "", images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] } });
  assert.equal(image.reason, "needs_visual"); assert.equal(sent.length, count);
  const absentReply = await classifier.classify({ ...request, works: [] });
  assert.equal(absentReply.reason, "reply_context_budget"); assert.equal(sent.length, count);
  const many = await createIntentClassifier(configuration, { clef: { ...clef, model: "clef" }, inputTokens: 65536 }).classify({ ...request, replyTargets: [], works: Array.from({ length: 140 }, (_, i) => ({ id: `work-${i}`, summary: "", status: "queued" })) });
  assert.equal(sent.at(-1)!.state.incomplete, true);
  assert.equal(Object.keys(sent.at(-1)!.questions.route.criteria).length, 255);
  assert.equal(many.reason, "incomplete_target");
});

test("a late Clef cancellation is discarded even when the transport ignores abort", async t => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    await new Promise(resolve => setTimeout(resolve, 40));
    return Response.json(answer(JSON.parse(String(init.body)), "cancel_0"));
  });
  const result = await createIntentClassifier(configuration, { clef, timeoutMs: 10 }).classify(request);
  assert.equal(result.reason, "timeout"); assert.deepEqual(result.actions, []);
});

test("Clef is opt-in and validates credentials, model, window and confidence without changing model aliases", () => {
  assert.deepEqual(intentEnvironment({ ASSISTANT_INTENT_MODEL: "fast" }), { model: "fast" });
  const options = intentEnvironment({ ASSISTANT_INTENT_PROVIDER: "clef", CLOUDFLARE_ACCOUNT_ID: clef.accountId, CLOUDFLARE_API_TOKEN: clef.apiToken });
  assert.deepEqual(options, { clef }); assert.doesNotThrow(() => createIntentClassifier(configuration, options));
  assert.throws(() => intentEnvironment({ ASSISTANT_INTENT_PROVIDER: "clef", ASSISTANT_INTENT_MODEL: "fast" }), /MODEL/);
  assert.throws(() => intentEnvironment({ ASSISTANT_INTENT_PROVIDER: "typo" }), /PROVIDER/);
  assert.throws(() => intentEnvironment({ ASSISTANT_INTENT_PROVIDER: "clef", ASSISTANT_INTENT_MIN_CONFIDENCE: "bad" }), /CONFIDENCE/);
  assert.throws(() => createIntentClassifier(configuration, intentEnvironment({ ASSISTANT_INTENT_PROVIDER: "clef" })), /凭据/);
  assert.throws(() => createIntentClassifier(configuration, { clef, model: "other" }), /同时/);
  assert.throws(() => createIntentClassifier(configuration, { clef, inputTokens: 24577 }), /窗口/);
});

test("a Clef compound input reaches the same main assistant intact without cancelling queued work", { timeout: 15000 }, async t => {
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const busy = new Promise<void>(resolve => { entered = resolve; });
  const main: string[] = [];
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!String(url).startsWith("https://api.cloudflare.com/")) return originalFetch(url, init);
    const wire = JSON.parse(String(init?.body)); return Response.json(answer(wire, wire.state.current.text === "取消报表；再查天气。" ? "compound" : "request"));
  });
  const f = await assistantFixture(async (wire, response) => {
    main.push(JSON.stringify(wire.messages));
    if (main.length === 1) { entered(); await held; }
    sendChatCompletion(response, "handled");
  }, async () => ({ intent: { clef } }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "busy", text: "busy" }); await busy;
    await f.app.receive({ conversationId: "one", inputId: "report", text: "生成报表" });
    await f.app.receive({ conversationId: "one", inputId: "compound", text: "取消报表；再查天气。" }); await f.app.waitForRouting();
    assert.equal(f.app.routingStatus("one").model, "clef-flash");
    assert.equal(f.app.routingStatus("one").works.find(work => work.inputId === "report")?.status, "queued");
    release(); await f.app.waitForIdle();
    assert.ok(main.slice(1).some(text => text.includes("取消报表；再查天气。") && text.includes("compound")));
    assert.ok(f.app.routingStatus("one").works.every(work => work.status === "completed"));
    assert.ok(!f.outputs.some(output => output.type === "text" && /已取消|已请求停止/.test(output.text)));
  } finally { release(); await f.close(); }
});
