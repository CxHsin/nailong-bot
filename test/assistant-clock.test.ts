import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableExecutor } from "../src/assistant/durable-executor.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

const originalTimeZone = process.env.TZ;
beforeEach(() => { process.env.TZ = "Asia/Shanghai"; });
afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

async function fixture(provider: (body: any, response: ServerResponse) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "nailong-clock-"));
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    try { await provider(JSON.parse(body), response); }
    catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port missing");
  const options = { cwd: directory, dataDir: join(directory, "executions"),
    prompt: "You are a personal assistant.", modelConfiguration: { defaultModel: "local", models: [
      { alias: "local", api: "openai-completions" as const, model: "local", apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}` },
    ] } };
  return { directory, options, async close() {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

const batch = (id: string, text: string) => ({ id, requestKey: id, conversationId: "one", events: [
  { inputId: id, conversationId: "one", text },
] });
const systemOf = (body: any) => body.messages
  .filter((message: any) => message.role === "system")
  .map((message: any) => JSON.stringify(message.content)).join("\n");

test("current time rides at the tail of the input and never inside the cached system prefix", async () => {
  const requests: any[] = [];
  const f = await fixture((body, response) => { requests.push(body); sendChatCompletion(response, "现在是上午九点五十四分。"); });
  const executor = await createDurableExecutor({ ...f.options, clock: () => new Date("2026-10-20T01:54:00Z") });
  try {
    await executor.execute(batch("b1", "现在几点了"), { emit: async () => {}, recordSubmission() {} });
    assert.equal(requests.length, 1);
    // The cached prefix must stay byte-identical across turns, so it cannot carry a clock.
    assert.doesNotMatch(systemOf(requests[0]), /当前时间：/);
    // The clock travels with the new input instead.
    const tail = JSON.stringify(requests[0].messages.at(-1).content);
    assert.match(tail, /当前时间：/);
    assert.match(tail, /2026年10月20日/);
    assert.match(tail, /UTC\+08:00/);
    assert.doesNotMatch(tail, /这是本轮输入发生的时刻/);
    assert.match(requests[0].messages.at(-1).content.at(-1).text, /^当前时间：[^\n]+。$/);
  } finally { await executor.close(); await f.close(); }
});

test("consecutive turns keep the system prefix byte-identical so prompt cache still hits", async () => {
  const requests: any[] = [];
  let turn = 0;
  const f = await fixture((body, response) => { requests.push(body); sendChatCompletion(response, `回答${++turn}`); });
  // Two different clocks: a naive system timestamp would break the prefix here.
  const times = [new Date("2026-10-20T01:54:00Z"), new Date("2026-10-20T06:20:00Z")];
  let index = 0;
  const executor = await createDurableExecutor({ ...f.options, clock: () => times[index++]! });
  try {
    await executor.execute(batch("b1", "第一句"), { emit: async () => {}, recordSubmission() {} });
    await executor.execute(batch("b2", "第二句"), { emit: async () => {}, recordSubmission() {} });
    assert.equal(requests.length, 2);
    assert.equal(systemOf(requests[0]), systemOf(requests[1]), "system prefix changed between turns and would void the cache");
    // The second turn still sees its own fresh clock, just not in the prefix.
    const tail = JSON.stringify(requests[1].messages.at(-1).content);
    assert.match(tail, /14:20/);
  } finally { await executor.close(); await f.close(); }
});

test("the clock reflects the injected time rather than the process clock", async () => {
  const requests: any[] = [];
  const f = await fixture((body, response) => { requests.push(body); sendChatCompletion(response, "ok"); });
  const executor = await createDurableExecutor({ ...f.options, clock: () => new Date("2027-03-05T23:30:00Z") });
  try {
    await executor.execute(batch("b1", "现在几点了"), { emit: async () => {}, recordSubmission() {} });
    const tail = JSON.stringify(requests[0].messages.at(-1).content);
    // 2027-03-05T23:30Z is 2027-03-06 07:30 in Asia/Shanghai.
    assert.match(tail, /2027年03月06日/);
    assert.match(tail, /07:30/);
  } finally { await executor.close(); await f.close(); }
});

test("a UTC host reports UTC rather than silently assuming Shanghai", async () => {
  process.env.TZ = "UTC";
  const requests: any[] = [];
  const f = await fixture((body, response) => { requests.push(body); sendChatCompletion(response, "ok"); });
  const executor = await createDurableExecutor({ ...f.options, clock: () => new Date("2027-03-05T23:30:00Z") });
  try {
    await executor.execute(batch("utc", "现在几点了"), { emit() {}, recordSubmission() {} });
    const tail = JSON.stringify(requests[0].messages.at(-1).content);
    assert.match(tail, /2027年03月05日.*23:30/);
    assert.match(tail, /UTC\+00:00，UTC/);
  } finally { await executor.close(); await f.close(); }
});
