import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";
import { replayEvents } from "../src/context/projection.js";
import { getModel } from "@mariozechner/pi-ai";
import { assistantText } from "../src/agent/model-message.js";
import { deliverContent } from "../src/runtime/content-delivery.js";

test("an incomplete old result plan never replays its unseen tail as delivered", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "old-result-replay-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const text = "甲".repeat(3500) + "\n\n" + "未送达乙".repeat(400) + "\n\n尾部";
  await log.appendBatch([
    { type: "message", role: "user", requestId: "old", text: "旧问题" },
    { type: "text_snapshot", requestId: "old", textSegmentId: "result-prefix", protocolVersion: "json-text-v2", contentKind: "result", validatedPrefix: true, text },
    { type: "telegram_page", requestId: "old", textSegmentId: "result-prefix", partIndex: 0, text: "甲".repeat(3500) },
    { type: "telegram_delivery_succeeded", requestId: "old", textSegmentId: "result-prefix", partIndex: 0, telegramMessageId: 1 },
    { type: "text_finalized", requestId: "old", textSegmentId: "result-prefix", protocolVersion: "json-text-v2", contentKind: "result", text },
    { type: "request_interrupted", requestId: "old" },
    { type: "message", role: "user", requestId: "new", text: "继续" },
  ]);
  const model = getModel("deepseek", "deepseek-v4-flash");
  const raw = await log.read();
  assert.ok(raw.every((e) => e.conversationId === undefined && e.chatId === undefined));
  const replay = await replayEvents(log, "new", model, true);
  assert.ok(!JSON.stringify(replay.units).includes("未送达乙"));
  assert.deepEqual(await log.read(), raw, "replay never assigns ownership or rewrites original facts");
});

test("independent delivery and model views refresh and rebuild regardless of read order", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "independent-views-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir); const model = getModel("deepseek", "deepseek-v4-flash");
  await log.appendBatch([
    { type: "message", role: "user", text: "旧问题", requestId: "old" },
    { type: "text_finalized", requestId: "old", textSegmentId: "stage", protocolVersion: "json-text-v2", contentKind: "result", text: "独立视图成果" },
    { type: "message", role: "user", text: "当前问题", requestId: "current" },
  ]);
  const sent: string[] = []; const transport = { send: async (text: string) => { sent.push(text); return sent.length; } };
  const replay = () => replayEvents(log, "current", model, true);
  const before = await replay(); assert.ok(!JSON.stringify(before.units).includes("独立视图成果"));
  await deliverContent(log, "old", 42, { id: "stage", kind: "progress", text: "独立视图成果" }, transport);
  const after = await replay(); assert.ok(JSON.stringify(after.units).includes("独立视图成果"));
  assert.ok(!JSON.stringify(before.units).includes("独立视图成果"));
  await deliverContent(log, "old", 42, { id: "stage", kind: "progress", text: "独立视图成果" }, transport);
  assert.deepEqual((await replay()).units, after.units); assert.deepEqual(sent, ["独立视图成果"]);
  await log.append({ type: "text_finalized", requestId: "old", textSegmentId: "next-stage", protocolVersion: "json-text-v2", contentKind: "result", text: "追加成果" });
  assert.ok(!JSON.stringify((await replay()).units).includes("追加成果"));
  await deliverContent(log, "old", 42, { id: "next-stage", kind: "progress", text: "追加成果" }, transport);
  const refreshed = await replay(); assert.ok(JSON.stringify(refreshed.units).includes("追加成果"));
  await deliverContent(log, "old", 42, { id: "next-stage", kind: "progress", text: "追加成果" }, transport);
  assert.deepEqual((await replay()).units, refreshed.units); assert.deepEqual(sent, ["独立视图成果", "追加成果"]);
});
for (const delivery of ["none", "prefix", "complete", "active"] as const) {
  test(`tool-associated result replay respects ${delivery} delivery while preserving tool facts`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "result-tool-replay-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const log = createSqliteRuntimeLog(dir);
    const model = getModel("deepseek", "deepseek-v4-flash"); assert.ok(model);
    const text = "阶段性成果尚未展示";
    const message = assistantText(JSON.stringify({ type: "result", text }), model);
    message.content.push({ type: "toolCall", id: "call", name: "ls", arguments: { path: "." } });
    message.stopReason = "toolUse";
    await log.append({ type: "message", role: "user", requestId: "old", text: "分析目录" });
    await log.append({ type: "model_message", requestId: "old", modelStepId: "step", protocolVersion: "json-text-v2", message });
    await log.append({ type: "protocol_validated", requestId: "old", modelStepId: "step", valid: true });
    await log.append({ type: "text_finalized", requestId: "old", modelStepId: "step", textSegmentId: "stage",
      contentKind: "result", text, protocolVersion: "json-text-v2" });
    await log.append({ type: "tool_dispatch", requestId: "old", toolCallId: "call", toolName: "ls", args: { path: "." } });
    await log.append({ type: "tool_result", requestId: "old", toolCallId: "call", toolName: "ls",
      result: { content: [{ type: "text", text: "真实目录结果" }], details: {}, isError: false } });
    if (delivery === "prefix" || delivery === "complete") {
      await log.append({ type: "telegram_page", textSegmentId: "stage", partIndex: 0 });
      await log.append({ type: "telegram_delivery_succeeded", textSegmentId: "stage", partIndex: 0 });
      if (delivery === "complete") await log.append({ type: "telegram_plan_finalized", textSegmentId: "stage", parts: 1 });
    }
    if (delivery !== "active") {
      await log.append({ type: "request_failed", requestId: "old" });
      await log.append({ type: "message", role: "user", requestId: "new", text: "继续" });
    }
    for (const structured of [true, false]) {
      const replay = await replayEvents(log, delivery === "active" ? "old" : "new", model, structured);
      const messages = replay.units.flatMap((unit) => unit.messages);
      assert.ok(messages.some((entry) => entry.role === "toolResult" && entry.toolCallId === "call"));
      assert.ok(JSON.stringify(messages).includes("真实目录结果"));
      const assistant = messages.find((entry) => entry.role === "assistant");
      assert.ok(assistant && assistant.content.some((part) => part.type === "toolCall" && part.id === "call"));
      if (delivery === "complete") assert.ok(JSON.stringify(assistant).includes(text));
      else if (delivery === "active") {
        assert.ok(JSON.stringify(assistant).includes(text));
        assert.ok(JSON.stringify(assistant).includes("尚未确认送达用户"));
        if (structured) assert.ok(!assistant.content.some((part) => part.type === "text" && JSON.parse(part.text).type === "result"));
      } else assert.ok(!JSON.stringify(replay.units).includes(text));
    }
  });
}
