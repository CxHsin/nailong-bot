import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tinyfishResultText } from "../src/tinyfish.js";
import { createRuntimeLog, readableResult } from "../src/runtime-log.js";
import { toolResultView } from "../src/tool-result-projection.js";

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
