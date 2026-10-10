import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramProviderFixture as fixture, sendChatCompletion as output } from "./fixtures/telegram-provider.js";
import { join } from "node:path";

import { memoryNodes } from "../src/runtime/memory-facts.js";
test("production plain Pi tool progress reaches Telegram without polluting subsequent model or learning context", async (t) => {
  const { f, wire } = await fixture(t, (res, requests, dir) => output(res, requests.length === 1 ? "先检查文件。" : "检查完成。", requests.length === 1 ? [{ index: 0, id: "read-file", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(dir, "prompt.md") }) } }] : undefined));
  await f.send("检查文件"); assert.equal(wire.length, 2);
  assert.ok(f.drafts.some((e) => e.text.includes("先检查文件")));
  assert.ok(f.sent.includes("检查完成。"));
  const events = await f.rootLog.read();
  assert.ok(events.some((e) => e.type === "tool_dispatch" && e.toolCallId === "read-file"));
  assert.ok(events.some((e) => e.type === "tool_result" && e.toolCallId === "read-file"));
  assert.ok(events.some((e) => e.type === "context_phase_timing" && typeof e.restoreMs === "number" && typeof e.selectMs === "number" && typeof e.loadMs === "number"));
  assert.ok(!events.some((e) => e.type === "progress" || e.type === "progress_event" || e.type === "text_snapshot"));
  assert.deepEqual(memoryNodes(events, 42)[0]?.messages.filter((m) => m.role === "assistant").map((m) => m.text), ["检查完成。"]);
  await f.send("继续"); const next = JSON.stringify(wire[2]);
  assert.doesNotMatch(next, /正在调用|已完成：/); assert.match(next, /检查完成/);
});
