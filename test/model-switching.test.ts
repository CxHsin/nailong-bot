import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { createAgentHost } from "../src/application/agent-host.js";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { createCliChannel } from "../src/cli/cli-channel.js";
import { projectNativeContext } from "../src/context/provider-aware.js";
import { assistantText } from "../src/agent/model-message.js";
import { gptEnvironment, gptModel } from "../src/agent/model-config.js";
import { closeFixture } from "./fixtures/cleanup.js";

test("model controls serialize, persist per Conversation and share CLI continuation without model calls", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "model-controls-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; });
  const choices: string[] = [];
  const agent = { models: [{ alias: "ds" as const, name: "DS" }, { alias: "gpt" as const, name: "GPT" }],
    answer: async (_messages: unknown, request: { modelAlias?: string }) => { choices.push(request.modelAlias!); if (choices.length === 1) { started(); await wait; } return "answer"; } };
  const make = () => createAgentHost({ log, dataDir: dir, promptFile: join(dir, "prompt.md"), agent });
  let host = make(); const submit = (text: string, conversationId = "telegram:private:42") => host.submit({ actor: { id: "owner" }, conversationId, text });
  const first = submit("first"); await began;
  const switching = submit("/model gpt");
  assert.equal((await log.read()).some((event) => event.type === "model_selected"), false);
  release(); await first.done; assert.match(String((await switching.done).result?.text), /gpt/);
  host = make();
  const cli = createCliChannel({ host, actor: { id: "cli" }, stdout: () => {}, stderr: () => {} });
  await cli.send("continued", { conversationId: "telegram:private:42" });
  await submit("other", "c2").done;
  assert.match(String((await submit("/model").done).result?.text), /当前模型：gpt/);
  await submit("/reset").done; await submit("after reset").done;
  assert.match(String((await submit("/model wrong").done).result?.text), /用法/);
  await submit("/model ds").done; await submit("back").done;
  assert.deepEqual(choices, ["ds", "gpt", "ds", "gpt", "ds"]);
  assert.ok((await log.read()).filter((event) => event.type === "message").every((event) => !String(event.text).startsWith("/model")));
  const unavailable = createAgentHost({ log, dataDir: dir, promptFile: "unused", agent: { answer: async () => "unused" } });
  assert.match(String((await unavailable.submit({ actor: { id: "owner" }, conversationId: "c2", text: "/model gpt" }).done).result?.text), /尚未配置/);
});

test("native projection admits only same-model encrypted reasoning and preserves tool facts and images", () => {
  const model = gptModel({ apiKey: "test" });
  const original = assistantText("answer", model);
  original.content.unshift({ type: "thinking", thinking: "hidden", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] }) });
  const same = projectNativeContext({ messages: [original] }, model).messages[0]!;
  assert.equal(same.role, "assistant");
  if (same.role === "assistant") assert.deepEqual(same.content[0], { type: "thinking", thinking: "", thinkingSignature: original.content[0]!.type === "thinking" ? original.content[0]!.thinkingSignature : "" });
  assert.doesNotMatch(JSON.stringify(projectNativeContext({ messages: [original] }, { ...model, id: "other" })), /opaque|hidden/);
  original.content[0] = { type: "thinking", thinking: "not replayable", thinkingSignature: "malformed" };
  assert.doesNotMatch(JSON.stringify(projectNativeContext({ messages: [original] }, model)), /malformed|not replayable/);
  assert.throws(() => projectNativeContext({ messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "aW1n" }], timestamp: 0 }] }, { ...model, input: ["text"] }), /不支持/);
  assert.throws(() => gptEnvironment({ XH_API_KEY: "test", XH_CONTEXT_WINDOW: "wrong" }), /正整数/);
});

function responses(res: ServerResponse, tool: boolean, text = "GPT answer") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("response.created", { response: { id: "resp_1", status: "in_progress" } });
  const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "opaque-fixture", summary: [] };
  emit("response.output_item.added", { output_index: 0, item: { ...reasoning, encrypted_content: undefined } });
  emit("response.output_item.done", { output_index: 0, item: reasoning });
  if (tool) {
    const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: JSON.stringify({ path: "note.txt" }) };
    emit("response.output_item.added", { output_index: 1, item: { ...item, arguments: "" } });
    emit("response.function_call_arguments.done", { output_index: 1, arguments: item.arguments });
    emit("response.output_item.done", { output_index: 1, item });
  } else {
    emit("response.output_item.added", { output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [] } });
    emit("response.content_part.added", { output_index: 1, part: { type: "output_text", text: "", annotations: [] } });
    emit("response.output_text.delta", { output_index: 1, delta: text });
    emit("response.output_item.done", { output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } });
  }
  emit("response.completed", { response: { id: "resp_1", status: "completed", model: "gpt-6.1-sol", usage: { input_tokens: 100, output_tokens: 12, total_tokens: 112, input_tokens_details: { cached_tokens: 80 } } } });
  res.end();
}

test("production Host switches DS → XH Responses → DS with tools, restart history, reasoning and usage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "xh-provider-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful"); await writeFile(join(dir, "note.txt"), "source evidence");
  const seen: Array<{ path: string; body: Record<string, unknown>; auth?: string }> = [];
  let gptCalls = 0;
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    seen.push({ path: req.url!, body: JSON.parse(text), auth: req.headers.authorization });
    if (req.url === "/v1/responses") responses(res, ++gptCalls === 1);
    else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "DS answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const agent = await createPiAgent({ dataDir: dir, promptFile, deepseekKey: "ds-key", modelBaseUrl: baseUrl,
    gpt: { apiKey: "xh-key", baseUrl }, memoryBootstrap: false });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = await createRuntimeEventLog(dir);
  let host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = async (text: string, image = false) => {
    const event = await host.submit({ actor: { id: "owner" }, conversationId: "c1", text,
      ...(image ? { images: [{ type: "image", mimeType: "image/png", data: "aW1n" }] } : {}) }).done;
    assert.equal(event.type, "run_succeeded", event.error); return event;
  };
  await send("DS first", true); await send("/model gpt");
  const gpt = await send("read note.txt");
  assert.equal(gpt.result?.text, "GPT answer");
  assert.equal(seen[1]!.path, "/v1/responses"); assert.equal(seen[1]!.auth, "Bearer xh-key");
  assert.equal(seen[1]!.body.store, false); assert.equal(seen[1]!.body.model, "gpt-6.1-sol");
  assert.match(JSON.stringify(seen[1]!.body.input), /DS first|DS answer/);
  assert.match(JSON.stringify(seen[1]!.body.input), /input_image.*data:image\/png;base64,aW1n/);
  assert.match(JSON.stringify(seen[2]!.body.input), /function_call_output|source evidence/);
  assert.match(JSON.stringify(seen[2]!.body.input), /opaque-fixture/);
  host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  await send("continue GPT");
  assert.match(JSON.stringify(seen[3]!.body.input), /opaque-fixture/);
  await send("/model ds"); await send("continue DS");
  assert.equal(seen[4]!.auth, "Bearer ds-key");
  assert.doesNotMatch(JSON.stringify(seen[4]!.body), /opaque-fixture|\/model/);
  assert.match(JSON.stringify(seen[4]!.body), /GPT answer|source evidence/);
  const facts = await log.read();
  assert.ok(facts.some((event) => event.type === "model_usage" && event.provider === "xh" && (event.usage as { cacheRead: number }).cacheRead === 80));
  assert.equal(seen[1]!.body.prompt_cache_key, seen[3]!.body.prompt_cache_key);
  assert.match(JSON.stringify(seen[1]!.body), /reasoning.encrypted_content/);
  const summaryRequest = { id: gpt.runId, log, modelAlias: "gpt" as const };
  assert.equal(await agent.summarizeProgress({ task: "read", explanations: [], facts: [] }, summaryRequest, new AbortController().signal, () => {}), "GPT answer");
  assert.equal(seen[5]!.auth, "Bearer xh-key");
});

test("GPT compaction uses Responses and retains a valid checkpoint for continuation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "xh-compaction-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  let summaries = 0; const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    if (text.includes("HISTORY_COMPACTION")) {
      summaries++;
      responses(res, false, "## Goal\nContinue.\n## Progress\nEarlier work completed.\n## Constraints\nKeep requirements.\n## Decisions\nPreserve evidence.\n## Next Steps\nContinue work.\n## Critical Context\nConsult original logs for exact details.");
    } else responses(res, false);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, deepseekKey: "ds-key", memoryBootstrap: false,
    gpt: { apiKey: "xh-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, contextWindow: 7600, maxTokens: 1024 } });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = await createRuntimeEventLog(dir);
  for (let index = 0; index < 6; index++) {
    await log.append({ type: "message", role: "user", text: `old-${index}:` + "x".repeat(1500), conversationId: "c1" });
    await log.append({ type: "message", role: "assistant", text: "answer:" + "y".repeat(1500), conversationId: "c1" });
  }
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = async (text: string) => {
    const event = await host.submit({ actor: { id: "owner" }, conversationId: "c1", text }).done;
    assert.equal(event.type, "run_succeeded", event.error);
  };
  await send("/model gpt"); await send("continue");
  assert.ok(summaries > 0);
  await send("continue again");
  assert.ok(requests.every((body) => body.model === "gpt-6.1-sol"));
  assert.ok((await log.read()).some((event) => event.type === "model_usage" && event.purpose === "summary" && event.provider === "xh"));
});

test("XH rejection fails the Run without silently invoking DS", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "xh-rejection-")); const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  const paths: string[] = [];
  const server = createServer((req, res) => { paths.push(req.url!); res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "invalid token" } })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, deepseekKey: "ds-key", memoryBootstrap: false,
    gpt: { apiKey: "xh-key", baseUrl: `http://127.0.0.1:${address.port}/v1` } });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  await host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "/model gpt" }).done;
  assert.equal((await host.submit({ actor: { id: "owner" }, conversationId: "c1", text: "answer" }).done).type, "run_failed");
  assert.deepEqual(paths, ["/v1/responses"]);
});
