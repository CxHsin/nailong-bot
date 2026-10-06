import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModel } from "@mariozechner/pi-ai";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { createContextProjection } from "../src/context/context-budget.js";
import { estimateInput } from "../src/context/input-budget.js";

const summary = ["Goal", "Progress", "Constraints", "Decisions", "Next Steps", "Critical Context"]
  .map((heading) => `## ${heading}\n${"Keep recorded evidence and the remaining task. ".repeat(3)}`).join("\n");

test("long history batches complete turns instead of summarizing one old turn per call", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "compaction-batch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  for (let index = 0; index < 12; index++) {
    await log.append({ type: "message", role: "user", text: `old-${index}:` + "x".repeat(1600) });
    await log.append({ type: "message", role: "assistant", text: "y".repeat(1600) });
  }
  await log.append({ type: "message", role: "user", requestId: "current", text: "current task" });
  let calls = 0;
  const model = { ...getModel("deepseek", "deepseek-v4-flash"), contextWindow: 7600, maxTokens: 1024 };
  const projection = createContextProjection({ log, dataDir: dir, requestId: "current", structured: false,
    summarize: async (input) => { calls++; assert.ok(estimateInput(input) <= Math.floor(7600 * 0.86)); return summary; } });
  const result = await projection.project(model, { messages: [] });
  assert.ok(calls <= 2, `expected at most two batched summaries, observed ${calls}`);
  assert.equal(result.context.messages.at(-1)?.content, "current task");
  assert.ok(JSON.stringify(result.context.messages).includes("old-11:"), "retain recent original turns");
  assert.ok(estimateInput(result.context) <= Math.floor(7600 * 0.86));
  assert.equal((await log.read()).filter((event) => event.type === "message").length, 25);
});
