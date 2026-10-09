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
    "正在检索相关记忆……",
    "正在读取可用记忆……",
    "正在扫描记忆：0/0 条。",
    "正在匹配相关记忆：0/0 条。",
    "正在整理记忆关联……",
    "正在排序记忆候选……",
    "未找到相关旧记忆，继续处理当前问题。",
  ]);
  assert.ok(progress.every((event) => event.type === "text" && !event.formal && event.kind === "status"));
  assert.equal(progress[0]?.type === "text" && progress[0].actionState, "started");
  assert.ok((await log.read()).some((event) => event.type === "memory_recalled"));
  assert.ok(!(await log.read()).some((event) => JSON.stringify(event).includes("奶龙")));
});

test("live memory composition yields and keeps the exact synchronous selection", async () => {
  const { composeMemory, composeMemoryLive } = await import("../src/application/memory-context.js");
  const { memoryNodes } = await import("../src/runtime/memory-facts.js");
  const events = Array.from({ length: 80 }, (_, i) => [
    { type: "message", role: "user", chatId: 42, requestId: `r${i}`, text: `小面包${i} ` + "事实".repeat(200), at: "2026-10-06T00:00:00Z" },
    { type: "request_completed", requestId: `r${i}`, chatId: 42, at: "2026-10-06T00:00:00Z" },
  ]).flat();
  const candidates = memoryNodes(events, 42).map((node) => ({ node, score: 1, sources: ["literal"] }));
  assert.equal(candidates.length, 80);
  const context = { messages: [{ role: "user" as const, content: "小面包", timestamp: 0 }] };
  const counts: Array<{ checked: number; total: number; loaded: number }> = [];
  let yielded = false; setImmediate(() => { yielded = true; });
  const live = await composeMemoryLive([context, [], candidates, 200, "小面包"], (count) => counts.push(count));
  assert.deepEqual(live, composeMemory(context, [], candidates, 200, "小面包"));
  assert.ok(live.quotes.length > 0);
  assert.ok(yielded);
  assert.equal(counts.at(-1)?.checked, candidates.length);
  assert.equal(counts.at(-1)?.loaded, live.quotes.length);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(composeMemoryLive([context, [], candidates, 200, "小面包"], () => {}, controller.signal), /取消/);
});

test("recall streams actual scan and match counts before completion without changing candidates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "streamed-recall-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = Array.from({ length: 80 }, (_, i) => [
    { type: "message", role: "user", chatId: 42, requestId: `r${i}`, text: `小面包${i}`, at: "2026-10-06T00:00:00Z" },
    { type: "request_completed", requestId: `r${i}`, chatId: 42, at: "2026-10-06T00:00:00Z" },
  ]).flat();
  const log = { ...createRuntimeLog(dir), read: async () => events };
  const memory = createMemoryProjection({ log, dataDir: dir, userId: 42, now: () => Date.parse("2026-10-06T00:00:00Z") });
  const expected = await memory.search("小面包", 72, "current");
  const updates: RunProgress[] = []; let settled = false; let yielded = false;
  setImmediate(() => { yielded = true; });
  const actual = await recallMemory(memory, { id: "current", log, onProgress: (event) => {
    assert.equal(settled, false); updates.push(event);
  } }, "小面包");
  settled = true;
  assert.deepEqual(actual.candidates, expected);
  assert.ok(yielded);
  const texts = updates.flatMap((event) => event.type === "text" ? [event.text] : []);
  assert.ok(texts.some((text) => /正在扫描记忆：\d+\/80 条/.test(text) && !text.includes("80/80")), JSON.stringify(texts));
  assert.ok(texts.some((text) => /正在匹配相关记忆：\d+\/80 条/.test(text) && !text.includes("80/80")), JSON.stringify(texts));
  assert.equal(texts.at(-1), `检索完成：${expected.length} 条候选记忆。`);
  assert.ok(updates.every((event) => event.type === "text" && event.segmentId === "current:memory-recall" && !event.formal));
});

test("cancelling a live recall stops scanning without publishing completion or degradation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cancelled-recall-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  const controller = new AbortController(); const texts: string[] = [];
  const memory = createMemoryProjection({ log, dataDir: dir, userId: 42 });
  await assert.rejects(recallMemory(memory, { id: "r", log, signal: controller.signal, onProgress: (event) => {
    if (event.type !== "text") return;
    texts.push(event.text);
    if (event.text === "正在读取可用记忆……") controller.abort();
  } }, "取消"), /取消/);
  assert.doesNotMatch(texts.join("\n"), /检索完成|暂不可用/);
  assert.equal((await log.read()).length, 0);
});
