import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connectTinyfish, tinyfishResultText } from "../src/agent/tinyfish.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { readableResult } from "../src/runtime/tool-archive.js";
import { toolResultView } from "../src/context/tool-result-projection.js";

test("web fetch prefers fresh content by default and preserves explicit cache tolerance", async (t) => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({ tools: ["search", "fetch_content"].map((name) => ({
    name, inputSchema: { type: "object", properties: {} },
  })) }));
  t.mock.method(Client.prototype, "callTool", async (call: typeof calls[number]) => {
    calls.push(call);
    return { content: [{ type: "text", text: "page" }] };
  });
  const connection = await connectTinyfish("test-key");
  try {
    const fetch = connection.tools.find((tool) => tool.name === "web_fetch")!;
    const search = connection.tools.find((tool) => tool.name === "web_search")!;
    const args = { urls: ["https://example.com"] };
    // These adapters only consume call ID and params, not the SDK execution context.
    await Reflect.apply(fetch.execute, fetch, ["default", args]);
    await Reflect.apply(fetch.execute, fetch, ["explicit", { ...args, ttl: 300 }]);
    await Reflect.apply(fetch.execute, fetch, ["zero", { ...args, ttl: 0 }]);
    await Reflect.apply(search.execute, search, ["search", { query: "skills" }]);
    assert.deepEqual(calls, [
      { name: "fetch_content", arguments: { ...args, ttl: 0 } },
      { name: "fetch_content", arguments: { ...args, ttl: 300 } },
      { name: "fetch_content", arguments: { ...args, ttl: 0 } },
      { name: "search", arguments: { query: "skills" } },
    ]);
    assert.deepEqual(args, { urls: ["https://example.com"] });
  } finally { await connection.close(); }
});

test("long web results retain their tail through extraction, archival and reconstruction", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "web-result-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const text = "网页内容😀\n".repeat(10000) + "END OF PAGE";
  const extracted = tinyfishResultText({ content: [
    { type: "text", text }, { type: "text", text: "SECOND BLOCK" },
  ] });
  assert.equal(extracted, text + "\nSECOND BLOCK");
  const result = { content: [{ type: "text" as const, text: extracted }], details: {}, isError: false };
  const log = createRuntimeLog(dir);
  const archive = await log.archive(result);
  assert.equal(toolResultView("web_fetch", result, archive, false).modelVisible, "archive");
  const recovered = await log.recoverArchive(archive);
  assert.deepEqual(recovered, result);
  const reconstructed = readableResult(recovered).split("\n").map((line) => JSON.parse(line).text).join("");
  assert.deepEqual(JSON.parse(reconstructed), result);
});

test("web error results preserve the full upstream diagnostic", () => {
  const text = "x".repeat(31000) + "error tail";
  assert.equal(tinyfishResultText({ isError: true, content: [{ type: "text", text }] }), `查询失败：${text}`);
});
