import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { createMemoryProjection } from "../src/memory/projection.js";
import { recallMemory } from "../src/application/memory-context.js";
import type { RunProgress } from "../src/runtime/progress.js";

test("ordinary recall reports an empty notebook truthfully and progress stays ephemeral", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "persona-memory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  const progress: RunProgress[] = [];
  const memory = createMemoryProjection({ log, dataDir: dir, userId: 42 });
  const result = await recallMemory(memory, { id: "r", log, onProgress: (event) => progress.push(event) }, "小面包");
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(progress.map((event) => event.type === "text" ? event.text : ""), [
    "等等，让奶龙翻翻小本本，找找和这次问题有关的记忆……",
    "这次没有找到相关旧记忆，奶龙接着看当前问题！",
  ]);
  assert.ok(progress.every((event) => event.type === "text" && !event.formal && event.kind === "status"));
  assert.ok((await log.read()).some((event) => event.type === "memory_recalled"));
  assert.ok(!(await log.read()).some((event) => JSON.stringify(event).includes("奶龙")));
});
