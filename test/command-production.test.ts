import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createCliChannel } from "../src/cli/cli-channel.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { createTestServer } from "./fixtures/http-server.js";
import { closeFixture } from "./fixtures/cleanup.js";

test("CLI controls keep prompt and forgotten originals isolated through real Agent requests and restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "command-production-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "default-bot-instruction");
  const inputs: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    inputs.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "confirmed answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options = { dataDir: dir, promptFile, memoryBootstrap: false, modelConfiguration: { defaultModel: "test", models: [
    { alias: "test", api: "openai-completions" as const, baseUrl: `http://127.0.0.1:${address.port}`, model: "local", apiKey: "test" },
  ] } };
  let agent = await createPiAgent(options);
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = await createRuntimeEventLog(dir);
  let host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const output: string[] = []; const errors: string[] = [];
  const channel = () => createCliChannel({ host, actor: { id: "cli" }, stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
    onDelivered: (event) => host.recordDelivery(event, { channel: "cli" }) });
  const send = (text: string, conversationId = "shared") => channel().send(text, { conversationId, json: true });
  await send("/prompt set custom-bot-instruction");
  assert.match(String((await send("/prompt")).result?.text), /custom-bot-instruction/);
  assert.equal(inputs.length, 0);
  const original = await send("private-original-to-forget");
  assert.equal(original.type, "run_succeeded", original.error);
  assert.match(JSON.stringify(inputs[0]!.messages[0]), /custom-bot-instruction/);
  await send("/prompt reset");
  assert.match(String((await send("/prompt")).result?.text), /default-bot-instruction/);
  await send(`/memory log ${original.runId}`);
  await send(`/forget ${original.runId}`);
  assert.equal(inputs.length, 1, "pure controls never dispatch a Provider request");
  const facts = await log.read();
  const excluded = facts.find((event) => event.type === "memory_excluded");
  assert.equal(excluded?.nodeId, original.runId);
  assert.equal(excluded?.conversationId, "shared");
  assert.equal(facts.filter((event) => event.type === "memory_learned").length, 1, "controls do not add learned content");
  const receipt = facts.find((event) => event.type === "input_received" && event.intent === `/forget ${original.runId}`);
  assert.equal(receipt?.messageId, 0, "retain existing CLI receipt representation");
  assert.equal(receipt?.chatId, excluded?.userId);
  await agent.close(); agent = await createPiAgent(options); host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  await send("next question");
  assert.match(JSON.stringify(inputs[1]!.messages[0]), /default-bot-instruction/);
  assert.doesNotMatch(JSON.stringify(inputs[1]), /private-original-to-forget|\/prompt|\/forget|\/memory log/);
  await send("other conversation", "other");
  assert.doesNotMatch(JSON.stringify(inputs[2]), /next question/);
  assert.deepEqual(errors, []);
  assert.ok(output.map((line) => JSON.parse(line)).every((event) => event.runId && event.conversationId && Number.isInteger(event.seq)));
});
