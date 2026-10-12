import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { webReadPath, webResultPreview, webResultBody } from "../src/runtime/web-result.js";
import { toolResultView, replayToolResultView } from "../src/context/tool-result-projection.js";
import type { ToolResult } from "../src/runtime/runtime-types.js";

const body = "# 文档\n" + "定义：chief-of-staff 是统筹助手🐉。\n".repeat(500) + "尾部证据";
const result: ToolResult = { content: [{ type: "text", text: JSON.stringify({ results: [
  { url: "https://example.com/changelog", title: "更新", text: body },
  { url: "https://example.com/skills", title: "目录", text: "Navigation ".repeat(240) + "\nengineering\nin-progress\nproductivity",
    links: ["https://other.example.com/login", "https://example.com/skills/in-progress/chief-of-staff"] },
], errors: [{ url: "https://example.com/search", error: "unauthorized", status: 401 }] }) }], details: {}, isError: false };
const archive = { path: "result.txt", bytes: 10000, sha256: "a", rawPath: "result.json", rawBytes: 10000, rawSha256: "b" };

test("large web batch preserves short directory, provenance, errors and bounded previews", () => {
  const active = toolResultView("web_fetch", result, archive, false);
  assert.equal(active.modelVisible, "archive");
  const text = active.content.map((part) => part.type === "text" ? part.text : "").join("");
  assert.match(text, /engineering\nin-progress\nproductivity\n\[正文完整\]/);
  assert.match(text, /unauthorized（HTTP 401）/);
  assert.match(text, /#web=1/);
  assert.match(text, /https:\/\/example.com\/skills\/in-progress\/chief-of-staff/);
  assert.ok(text.indexOf("页面链接") < text.indexOf("https://other.example.com/login"));
  assert.doesNotMatch(text, /\\n|\\"/);
  assert.ok(Buffer.byteLength(JSON.stringify(active.content)) <= 7000);
  assert.deepEqual(replayToolResultView({ result, archive, recorded: "archive", projectionVersion: 2,
    archiveRead: false, olderThanRecent: true, toolName: "web_fetch" }).content, active.content);
  const legacy = replayToolResultView({ result, archive, recorded: "archive", projectionVersion: 1,
    archiveRead: false, olderThanRecent: true, toolName: "web_fetch" }).content;
  assert.match(JSON.stringify(legacy), /JSONL/);
  assert.doesNotMatch(JSON.stringify(legacy), /in-progress/, "the legacy presentation hides the directory clue that the new view must preserve");
});

test("web preview budget holds for ten Unicode pages and malformed envelopes fall back", () => {
  const batch: ToolResult = { ...result, content: [{ type: "text", text: JSON.stringify({ results:
    Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}`, title: "龙".repeat(100), text: "🐉".repeat(900) })) }) }] };
  const content = webResultPreview(batch, archive)!;
  assert.ok(content);
  assert.ok(Buffer.byteLength(JSON.stringify(content)) <= 7000);
  assert.equal(webResultPreview({ ...result, content: [{ type: "text", text: '{"results":[null]}' }] }, archive), undefined);
  assert.match(JSON.stringify(toolResultView("grep", result, archive, false).content), /JSONL/);
});
