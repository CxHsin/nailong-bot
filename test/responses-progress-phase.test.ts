import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";
import { createTelegramHostProjection } from "../src/channel/telegram/projection.js";
import { memoryNodes } from "../src/runtime/memory-facts.js";
import { createTestServer } from "./fixtures/http-server.js";
import { closeFixture } from "./fixtures/cleanup.js";
import { configuredModel } from "../src/agent/model-config.js";
import { replayEvents } from "../src/context/projection.js";
import { assistantText } from "../src/agent/model-message.js";
import { projectNativeContext } from "../src/context/provider-aware.js";

for (const toolSearch of ["native", "compat"] as const) for (const splitResponse of [false, true]) test(`Responses ${toolSearch} streams commentary and final ${splitResponse ? "across execution steps" : "from one call"} without an auxiliary model`, { timeout: 12000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "responses-phase-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "用中文回答");
  let calls = 0; let releaseFinding!: () => void; let releaseDelta!: () => void;
  const findingDelivered = new Promise<void>((resolve) => { releaseFinding = resolve; });
  const deltaDelivered = new Promise<void>((resolve) => { releaseDelta = resolve; });
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls++; res.writeHead(200, { "content-type": "text/event-stream" });
    if (calls > (splitResponse ? 2 : 1)) {
      const input = JSON.parse(body).input;
      const phaseOf = (value: string) => input.find((item: { role?: string; content?: Array<{ text?: string }> }) => item.role === "assistant" && item.content?.some((part) => part.text === value))?.phase;
      assert.equal(phaseOf("**已确认资料日期**，接下来核对结论。"), "commentary");
      assert.equal(phaseOf("最终结论。"), "final_answer");
    }
    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const item = (id: string, phase: string, text: string) => ({ type: "message", id, role: "assistant", phase, status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
    send({ type: "response.created", response: { id: "response", status: "in_progress" } });
    if (!splitResponse || calls === 1) {
    send({ type: "response.output_item.added", output_index: 0, item: { ...item("finding", "commentary", ""), content: [] } });
    send({ type: "response.content_part.added", output_index: 0, item_id: "finding", content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    send({ type: "response.output_text.delta", output_index: 0, item_id: "finding", content_index: 0, delta: "**已确认资料日期**，接下来核对结论。" });
    send({ type: "response.output_item.done", output_index: 0, item: item("finding", "commentary", "**已确认资料日期**，接下来核对结论。") });
    await findingDelivered;
    }
    if (splitResponse && calls === 1) {
      send({ type: "response.completed", response: { id: "response", status: "completed", usage: { input_tokens: 50, output_tokens: 10 } } });
      res.end(); return;
    }
    if (splitResponse) {
      const finding = JSON.parse(body).input.find((item: { role?: string; content?: Array<{ text?: string }> }) => item.role === "assistant" && item.content?.some((part) => part.text === "**已确认资料日期**，接下来核对结论。"));
      assert.equal(finding?.phase, "commentary", "continuation must retain the public phase on the exact assistant item");
    }
    send({ type: "response.output_item.added", output_index: 1, item: { ...item("final", "final_answer", ""), content: [] } });
    send({ type: "response.content_part.added", output_index: 1, item_id: "final", content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    send({ type: "response.output_text.delta", output_index: 1, item_id: "final", content_index: 0, delta: "最终结" });
    await deltaDelivered;
    send({ type: "response.output_text.delta", output_index: 1, item_id: "final", content_index: 0, delta: "论。" });
    send({ type: "response.output_item.done", output_index: 1, item: item("final", "final_answer", "最终结论。") });
    send({ type: "response.completed", response: { id: "response", status: "completed", usage: { input_tokens: 50, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } } } });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, memoryBootstrap: false, modelConfiguration: { defaultModel: "gpt", models: [
    { alias: "gpt", api: "openai-responses", model: "phase-test", apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}`, toolSearch },
  ] } });
  t.after(() => { releaseFinding(); releaseDelta(); return closeFixture({ server, dir, shutdown: () => agent.close() }); });
  const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const sent: string[] = []; const drafts: string[] = []; const draftIds: number[] = [];
  const transport = createTelegramRichTransport({
    sendRich: async (_chat, value) => { sent.push(value); return sent.length; },
    draftRich: async (id, _chat, value) => {
      drafts.push(value); draftIds.push(id);
      if (value.includes("**已确认资料日期**")) {
        assert.equal(sent.length, 0, "finding must remain in the Run draft until terminal");
        releaseFinding();
      }
      // Compat streams may not expose the item's final phase until settlement.
      if (value.includes("最终结")) releaseDelta();
    },
  });
  const run = host.submit({ actor: { id: "42" }, conversationId: "telegram:private:42", text: "核对资料" });
  await createTelegramHostProjection({ ...transport, chatId: 42, draftIntervalMs: 5,
    deliver: (event, content, signal) => host.deliverContent(event, content, transport, signal),
    onDelivered: (event, id) => host.recordDelivery(event, { channel: "telegram", telegramMessageId: id }),
  }).consume(run);
  assert.equal(calls, splitResponse ? 2 : 1);
  assert.equal((await run.done).result?.finalText, "最终结论。");
  assert.equal(new Set(draftIds).size, 1);
  assert.equal(sent.length, 2);
  assert.match(sent[0]!, /^<details><summary>运行进展<\/summary>/);
  assert.match(sent[0]!, /\*\*已确认资料日期\*\*，接下来核对结论。/);
  assert.doesNotMatch(sent[0]!, /最终结论/);
  assert.equal(sent.at(-1), "最终结论。");
  assert.ok(drafts.some((value) => value.includes("最终结")));
  assert.ok(drafts.some((value) => value.endsWith("</details>\n\n最终结论。")));
  const facts = await log.read();
  assert.deepEqual(facts.filter((fact) => fact.type === "text_finalized").map(({ phase, phaseSource }) => ({ phase, phaseSource })), [
    { phase: "commentary", phaseSource: "native" }, { phase: "final_answer", phaseSource: "native" },
  ]);
  assert.equal(facts.filter((fact) => fact.type === "text_finalized" && fact.contentKind === "progress").length, 1);
  assert.equal(facts.some((fact) => fact.purpose === "progress"), false);
  assert.deepEqual(memoryNodes(facts, 42)[0]?.messages.filter((message) => message.role === "assistant").map((message) => message.text), ["最终结论。"]);
  const restarted = createAgentHost({ dataDir: dir, promptFile, log: await createRuntimeEventLog(dir), agent });
  sent.length = 0;
  const continued = restarted.submit({ actor: { id: "42" }, conversationId: "telegram:private:42", text: "继续核对" });
  await createTelegramHostProjection({ ...transport, chatId: 42, draftIntervalMs: 5,
    deliver: (event, content, signal) => restarted.deliverContent(event, content, transport, signal),
  }).consume(continued);
  assert.equal((await continued.done).type, "run_succeeded");
});

test("multiple commentary items alongside a tool retain order and phases across restart, with cross-model signatures removed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "multiple-commentary-"));
  const log = await createRuntimeEventLog(dir);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const model = configuredModel({ alias: "gpt", api: "openai-responses", baseUrl: "https://phase.example/v1", model: "phase-test", apiKey: "test" });
  const original = assistantText("first", model);
  original.content = [
    { type: "text", text: "发现一", textSignature: JSON.stringify({ v: 1, id: "one", phase: "commentary" }) },
    { type: "text", text: "发现二", textSignature: JSON.stringify({ v: 1, id: "two", phase: "commentary" }) },
    { type: "toolCall", id: "read", name: "read", arguments: { path: "evidence" } },
  ];
  await log.append({ type: "message", role: "user", text: "核对", requestId: "old", conversationId: "c" });
  for (const [index, value] of ["发现一", "发现二"].entries()) await log.append({ type: "text_finalized", requestId: "old", modelStepId: "step", textSegmentId: `p${index}`, modelTextIndex: index, contentKind: "progress", text: value, protocolVersion: "plain-text-v3" });
  await log.append({ type: "model_message", requestId: "old", modelStepId: "step", protocolVersion: "plain-text-v3", message: original });
  await log.append({ type: "tool_dispatch", requestId: "old", toolCallId: "read", toolName: "read" });
  await log.append({ type: "tool_result", requestId: "old", toolCallId: "read", toolName: "read", result: { content: [{ type: "text", text: "证据" }], details: {}, isError: false } });
  await log.append({ type: "request_completed", requestId: "old" });
  await log.append({ type: "message", role: "user", text: "继续", requestId: "current", conversationId: "c" });
  const replay = await replayEvents(await createRuntimeEventLog(dir), "current", model, false);
  const messages = replay.units.flatMap((unit) => unit.messages);
  const commentary = messages.flatMap((message) => message.role === "assistant" ? message.content.filter((part) => part.type === "text") : []);
  assert.deepEqual(commentary.map((part) => part.text), ["发现一", "发现二"]);
  assert.ok(commentary.every((part) => JSON.parse(part.textSignature!).phase === "commentary"));
  assert.ok(messages.some((message) => message.role === "toolResult" && message.toolCallId === "read"));
  assert.doesNotMatch(JSON.stringify(projectNativeContext({ messages }, { ...model, id: "other" })), /textSignature/);
});
