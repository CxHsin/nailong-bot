import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { connectMcp } from "../src/agent/mcp-catalog.js";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";
import { persistMedia } from "../src/assistant/media.js";
import { Type } from "typebox";
import { join } from "node:path";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPfoAAAAASUVORK5CYII=";

async function mediaMcp(content: unknown[], isError = false) {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize" ? {
      protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "materials", version: "1" },
    } : message.method === "tools/list" ? { tools: [{ name: "materials", inputSchema: { type: "object", properties: {} } }] }
      : { content, isError, structuredContent: { provenance: "controlled MCP" } };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP fixture port missing");
  const connection = await connectMcp({ name: "media", url: `http://127.0.0.1:${address.port}` });
  return { ...connection, async close() {
    await connection.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

test("mixed MCP results reach the provider as a typed image and readable resource sources", async () => {
  const mcp = await mediaMcp([
    { type: "text", text: "one screenshot" },
    { type: "image", data: png, mimeType: "image/png" },
    { type: "resource_link", uri: "https://example.test/report", name: "report", mimeType: "text/plain" },
    { type: "resource", resource: { uri: "notes://report", mimeType: "text/plain", text: "source evidence" } },
  ]);
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(wire);
    if (requests.length === 1) sendChatCompletion(response, "", [{ index: 0, id: "materials", type: "function",
      function: { name: "materials", arguments: "{}" } }]);
    else if (requests.length === 2) {
      const text = wire.messages.flatMap((message) => typeof message.content === "string" ? [message.content] :
        Array.isArray(message.content) ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("\n");
      const path = text.match(/4\. resource: (.+) \(source notes:\/\/report\)/)?.[1];
      assert.ok(path, "the embedded resource must expose a real readable path");
      sendChatCompletion(response, "", [{ index: 0, id: "read-source", type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } }]);
    } else sendChatCompletion(response, "source checked");
  }, async () => ({ tools: mcp.source.tools }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "mixed", text: "Inspect this tool's material." });
    await f.app.waitForIdle();
    assert.equal(requests.length, 3);
    const messages = requests[1]!.messages;
    const text = messages.flatMap((message) => typeof message.content === "string" ? [message.content] :
      Array.isArray(message.content) ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("\n");
    assert.ok(!text.includes(png), "base64 must not be JSON text");
    assert.match(JSON.stringify(messages), /data:image\/png;base64/);
    assert.match(text, /https:\/\/example.test\/report/);
    assert.match(text, /notes:\/\/report/);
    assert.match(JSON.stringify(requests[2]!.messages), /source evidence/);
  } finally { await f.close(); await mcp.close(); }
});

test("batch media reaches the main provider as an ordered manifest with readable originals", async () => {
  let manifestPath = "";
  let requests = 0;
  const source = { kind: "tool", id: "screenshots-1" };
  const f = await assistantFixture(async (wire, response) => {
    requests++;
    if (requests === 1) sendChatCompletion(response, "", [{ index: 0, id: "batch-media", type: "function",
      function: { name: "screenshots", arguments: "{}" } }]);
    else {
      const messages = JSON.stringify(wire.messages);
      assert.ok(!messages.includes(png), "batch images must be routed before the main model request");
      assert.match(messages, /helper/);
      assert.ok(messages.includes(manifestPath.replaceAll("\\", "\\\\")));
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.deepEqual(manifest.source, source);
      assert.deepEqual(manifest.entries.map((entry: { order: number; type: string }) => [entry.order, entry.type]),
        [[2, "image"], [3, "image"], [4, "image"], [5, "resource"]]);
      for (const entry of manifest.entries.slice(0, 3)) {
        assert.equal((await readFile(entry.path)).toString("base64"), png);
      }
      assert.equal(await readFile(manifest.entries[3].path, "utf8"), "source notes");
      assert.equal(manifest.entries[3].uri, "notes://source");
      sendChatCompletion(response, "batch originals ready for helper");
    }
  }, async (directory) => ({ tools: [{ name: "screenshots", label: "screenshots", description: "Collect screenshots", parameters: Type.Object({}),
    async execute() {
      const result = await persistMedia(join(directory, "durable-media"), [
        { type: "text", text: "Screenshots from the same session" },
        ...Array.from({ length: 3 }, () => ({ type: "image", data: png, mimeType: "image/png" })),
        { type: "resource", resource: { uri: "notes://source", mimeType: "text/plain", text: "source notes" } },
      ], source);
      manifestPath = result.manifest!.path;
      return { content: result.output, details: {} };
    } }] }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "batch", text: "Analyze this screenshot batch." });
    await f.app.waitForIdle();
    assert.equal(requests, 2);
    assert.ok(f.outputs.some((output) => output.type === "text" && output.text === "batch originals ready for helper"));
  } finally { await f.close(); }
});

test("large user image batches have a bounded main-model view and durable ordered originals", async () => {
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => { requests.push(wire); sendChatCompletion(response, "batch ready"); });
  try {
    await f.app.receive({ conversationId: "one", inputId: "many-images", text: "Review this batch.",
      images: Array.from({ length: 30 }, () => ({ type: "image" as const, mimeType: "image/png", data: png })) });
    await f.app.waitForIdle();
    const first = JSON.stringify(requests[0]!.messages);
    assert.ok(!first.includes(png));
    assert.ok(first.length < 6000, `manifest listing must remain bounded; received ${first.length} characters`);
    const user = requests[0]!.messages.find((message) => message.role === "user")!;
    const text = typeof user.content === "string" ? user.content : (user.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n");
    const path = text.match(/Manifest: (.+)/)?.[1];
    assert.ok(path);
    const manifest = JSON.parse(await readFile(path, "utf8"));
    assert.equal(manifest.entries.length, 30);
    assert.equal(manifest.entries[29].order, 30);
    assert.equal((await readFile(manifest.entries[29].path)).toString("base64"), png);
    await f.reopen();
    assert.equal((await readFile(manifest.entries[0].path)).toString("base64"), png);
    await f.app.receive({ conversationId: "one", inputId: "after-reopen", text: "Continue with the same originals." });
    await f.app.waitForIdle();
    assert.ok(!JSON.stringify(requests[1]!.messages).includes(png));
    assert.ok(JSON.stringify(requests[1]!.messages).includes(path.replaceAll("\\", "\\\\")));
  } finally { await f.close(); }
});
