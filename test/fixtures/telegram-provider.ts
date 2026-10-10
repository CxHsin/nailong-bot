import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createTestServer } from "./http-server.js";
import { closeFixture } from "./cleanup.js";
import { createTelegramHostFixture, type TelegramHostFixtureOptions } from "./telegram-host.js";
import type { RuntimeLog, StoredEvent } from "../../src/runtime/runtime-types.js";
export type Wire = { messages: Array<{ role: string; content: unknown }> };
export async function createTelegramProviderFixture(t: TestContext, respond: (res: ServerResponse, wire: Wire[], dir: string) => void | Promise<void>, options: Omit<TelegramHostFixtureOptions, "agentOptions"> = {},
  agentOptions: Partial<TelegramHostFixtureOptions["agentOptions"]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "telegram-current-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "Be helpful.");
  const wire: Wire[] = [];
  const server = createTestServer(t, async (req: IncomingMessage, res: ServerResponse) => {
    let body = ""; for await (const chunk of req) body += chunk;
    wire.push(JSON.parse(body)); await respond(res, wire, dir);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let shutdown = async () => {};
  t.after(() => closeFixture({ server, dir, shutdown: () => shutdown() }));
  const f = await createTelegramHostFixture(t, { ...options, agentOptions: { dataDir: dir, promptFile,
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}`, model: "local", apiKey: "test" }] }, ...agentOptions } });
  shutdown = () => f.close();
  return { f, wire, dir, promptFile };
}
export function sendChatCompletion(res: ServerResponse, content: string, toolCalls?: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}
export function checkWrites(log: RuntimeLog, check: (event: Omit<StoredEvent, "at">) => void): RuntimeLog {
  return { ...log, append: async (event) => { check(event); return log.append(event); },
    appendBatch: async (events) => { events.forEach(check); return log.appendBatch!(events); } };
}
