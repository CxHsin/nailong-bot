import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { createTestServer } from "./fixtures/http-server.js";
import { closeFixture } from "./fixtures/cleanup.js";
import { conversationLog } from "../src/runtime/conversation-log.js";

test("a Conversation appends beyond three prior turns and restores its prefix after restart and snapshot corruption", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "continuous-context-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  const inputs: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    inputs.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ type: "final", text: `settled-answer-${inputs.length}` }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options = { outputProtocol: "json-text-v2" as const, dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false };
  let agent = await createPiAgent(options);
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = await createRuntimeEventLog(dir);
  let host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = async (text: string) => {
    const result = await host.submit({ actor: { id: "owner" }, conversationId: "c", text }).done;
    assert.equal(result.type, "run_succeeded", result.error);
  };
  for (let index = 1; index <= 5; index++) {
    await send(`turn-${index}`);
    if (index > 1) assert.deepEqual(inputs[index - 1]!.messages.slice(0, inputs[index - 2]!.messages.length), inputs[index - 2]!.messages);
  }
  assert.match(JSON.stringify(inputs.at(-1)), /turn-1/);
  await agent.close(); agent = await createPiAgent(options); host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  await send("after-restart");
  assert.match(JSON.stringify(inputs.at(-1)), /settled-answer-5/);
  const beforeCorruption = inputs.at(-1)!.messages;
  for (const name of await readdir(join(dir, "context-projections"))) await writeFile(join(dir, "context-projections", name), "broken");
  await agent.close(); agent = await createPiAgent(options); host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  await send("after-corruption");
  assert.deepEqual(inputs.at(-1)!.messages.slice(0, beforeCorruption.length), beforeCorruption);
  assert.equal((await log.read()).filter((event) => event.type === "active_context_started").length, 1);
  await send("/reset"); await send("fresh-context");
  assert.doesNotMatch(JSON.stringify(inputs.at(-1)), /turn-1|settled-answer-5|after-corruption/);
});

test("initial migration without a snapshot reconstructs the previous active scope and settled answer exactly once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "continuous-migration-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  const inputs: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    inputs.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ type: "final", text: "migrated-answer" }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options = { outputProtocol: "json-text-v2" as const, dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: `http://127.0.0.1:${address.port}`, memoryBootstrap: false };
  let agent = await createPiAgent(options);
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = await createRuntimeEventLog(dir);
  const scoped = conversationLog(log, "c");
  for (let index = 0; index < 8; index++) {
    await scoped.append({ type: "message", role: "user", requestId: `old${index}`, text: `original-${index}` });
    await scoped.append({ type: "answer_generated", requestId: `old${index}`, text: `last-final-${index}` });
    await scoped.append({ type: "run_succeeded", runId: `old${index}`, result: { kind: "model" } });
  }
  let host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const send = async (text: string) => {
    const result = await host.submit({ actor: { id: "owner" }, conversationId: "c", text }).done;
    assert.equal(result.type, "run_succeeded", result.error);
  };
  await send("migration-followup");
  assert.match(JSON.stringify(inputs.at(-1)), /original-4|last-final-7/);
  const start = (await log.read()).find((event) => event.type === "active_context_started")!;
  assert.equal(start.migration, "legacy-reconstruction");
  for (let index = 0; index < 5; index++) await send(`new-${index}`);
  for (const name of await readdir(join(dir, "context-projections"))) await writeFile(join(dir, "context-projections", name), "broken");
  await agent.close(); agent = await createPiAgent(options); host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  await send("reconstructed");
  assert.match(JSON.stringify(inputs.at(-1)), /original-4/);
  // Old facts remain out of the active projection, though Akasha may separately recall them.
  const messages = inputs.at(-1)!.messages.filter((message) => !message.content.startsWith("长期记忆原文引用"));
  assert.doesNotMatch(JSON.stringify(messages), /original-0|original-1|original-2|original-3/);
  assert.equal((await log.read()).filter((event) => event.type === "active_context_started").length, 1);
  assert.equal(typeof start.sourceDigest, "string");
});
