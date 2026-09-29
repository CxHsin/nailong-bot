import assert from "node:assert/strict";
import test from "node:test";
import { projectDeliveredChat, projectRequestState, projectTelegramSegment } from "../src/runtime-projections.js";
import { replayToolResultView, toolResultView } from "../src/tool-result-projection.js";
import type { StoredEvent, ToolResult } from "../src/runtime-log.js";

const at = "2026-01-01T00:00:00Z";
const event = (value: { type: string; [key: string]: unknown }): StoredEvent => ({ ...value, at });

test("request, chat, and Telegram views rebuild from committed events", () => {
  const events = [
    event({ type: "request_started", requestId: "a" }),
    event({ type: "message", requestId: "a", role: "user", text: "hello" }),
    event({ type: "answer_generated", requestId: "a", text: "reply" }),
    event({ type: "text_snapshot", requestId: "a", textSegmentId: "s", text: "reply",
      eventId: "e", sequence: 1 }),
    event({ type: "text_finalized", requestId: "a", textSegmentId: "s", contentKind: "final", text: "reply" }),
    event({ type: "telegram_delivery_succeeded", requestId: "a", textSegmentId: "s", partIndex: 0,
      attemptId: "try", snapshotEventId: "e", text: "reply" }),
    event({ type: "delivery_succeeded", requestId: "a" }),
    event({ type: "request_completed", requestId: "a" }),
  ];
  assert.deepEqual([...projectRequestState(events).open], []);
  assert.deepEqual(projectDeliveredChat(events), [{ role: "user", text: "hello" },
    { role: "assistant", text: "reply" }]);
  assert.equal(projectTelegramSegment(events, "s").deliveries.length, 1);
});

test("recorded tool result view remains stable as it ages", () => {
  const result: ToolResult = { content: [{ type: "text", text: "x".repeat(10000) }],
    details: {}, isError: false };
  const archive = { path: "result.txt", bytes: 10000, sha256: "a", rawPath: "result.json",
    rawBytes: 10000, rawSha256: "b" };
  const active = toolResultView("read", result, archive, true);
  assert.equal(active.modelVisible, "original");
  const replay = replayToolResultView({ result, archive, recorded: active.modelVisible,
    archiveRead: true, olderThanRecent: true, toolName: "read" });
  assert.deepEqual(replay.content, result.content);
});
