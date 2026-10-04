import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";

test("full migration retains original identities, learning, exclusion and unknown delivery without writing the source", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-migration-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = createSqliteRuntimeLog(dir);
  await source.appendBatch([
    { type: "message", role: "user", requestId: "old-run", chatId: 42, text: "原话" },
    { type: "text_finalized", requestId: "old-run", textSegmentId: "stage", contentKind: "status", text: "核对原资料。", protocolVersion: "json-text-v2" },
    { type: "memory_learned", requestId: "old-run", deliveredSources: ["stable-source"], activated: [{ nodeId: "old-run", shown: [{ messageId: "stable-source", offset: 0, end: 2 }] }] },
    { type: "memory_excluded", userId: 42, nodeId: "old-run" },
    { type: "telegram_delivery_unknown", requestId: "old-run", textSegmentId: "stage", attemptId: "attempt", partIndex: 0 },
  ]);
  const original = await source.read();
  const target = await createRuntimeEventLog(dir);
  const migrated = await target.read();
  assert.equal(migrated.length, original.length);
  assert.deepEqual(migrated.map((event) => event.eventId), original.map((event) => event.eventId));
  assert.deepEqual(migrated.map((event) => event.sequence), original.map((event) => event.sequence));
  assert.ok(migrated.every((event) => event.schemaVersion === 2));
  assert.deepEqual(migrated[2]!.activated, original[2]!.activated);
  assert.equal(migrated[1]!.contextPolicy, "include");
  assert.deepEqual(await source.read(), original);
  const report = await target.migrationReport();
  assert.equal(report.referencesVerified, false);
  assert.ok(report.exceptions.some((item) => item.relation === "delivery-attempt"));
  await target.append({ type: "request_interrupted", requestId: "old-run" });
  assert.equal((await (await createRuntimeEventLog(dir)).read()).length, 6);
  assert.deepEqual(await source.read(), original);
});

test("migration rejects contradictory tool associations before selecting the new store", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "migration-association-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = createSqliteRuntimeLog(dir);
  await source.appendBatch([
    { type: "tool_dispatch", requestId: "r", toolCallId: "t", toolName: "read" },
    { type: "tool_result", requestId: "r", toolCallId: "t", toolName: "write", result: { content: [], isError: false } },
  ]);
  const original = await source.read();
  await assert.rejects(createRuntimeEventLog(dir), /工具关联/);
  assert.deepEqual(await source.read(), original);
  assert.equal((await createSqliteRuntimeLog(dir, { fileName: "runtime-v2.sqlite" }).read()).length, 0);
});

test("migration rejects a memory source range beyond Unicode code-point bounds", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "migration-ranges-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = createSqliteRuntimeLog(dir);
  const message = await source.append({ type: "message", role: "user", requestId: "r", chatId: 42, text: "😀原话", messageId: 5, images: [{ type: "image", data: "abc", mimeType: "image/png" }] });
  await source.append({ type: "memory_presented", requestId: "r2", shown: [{ nodeId: "r", messageId: message.eventId, offset: 0, end: 4 }] });
  await assert.rejects(createRuntimeEventLog(dir), /来源区间/);
});

test("migration verifies and retains valid page, memory, reply, image and archive source chains", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "migration-source-chains-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = createSqliteRuntimeLog(dir);
  const message = await source.append({ type: "message", role: "user", requestId: "r", chatId: 42, text: "😀原话", messageId: 5, images: [{ type: "image", data: "abc", mimeType: "image/png" }] });
  const result = { content: [{ type: "text" as const, text: "原始资料" }], details: {}, isError: false }; const archive = await source.archive(result);
  await source.append({ type: "tool_dispatch", requestId: "r", toolName: "read", toolCallId: "t" });
  const originalTool = await source.append({ type: "tool_result", requestId: "r", toolName: "read", toolCallId: "t", result, archive });
  await source.appendBatch([
    { type: "tool_dispatch", requestId: "r", toolName: "read", toolCallId: "archive" },
    { type: "tool_result", requestId: "r", toolName: "read", toolCallId: "archive", result: { ...result, details: { archiveSourceId: originalTool.eventId } } },
    { type: "text_finalized", requestId: "r", textSegmentId: "f", contentKind: "final", text: "答案" },
    { type: "telegram_page", requestId: "r", textSegmentId: "f", partIndex: 0, text: "答案", target: 42 },
    { type: "telegram_plan_finalized", requestId: "r", textSegmentId: "f", parts: 1 },
    { type: "telegram_delivery_attempt", requestId: "r", textSegmentId: "f", partIndex: 0, target: 42, attemptId: "a" },
    { type: "telegram_delivery_succeeded", requestId: "r", textSegmentId: "f", partIndex: 0, target: 42, attemptId: "a", telegramMessageId: 21 },
    { type: "memory_presented", requestId: "r2", shown: [{ nodeId: "r", messageId: message.eventId, offset: 0, end: 3 }] },
    { type: "message", role: "user", requestId: "r2", chatId: 42, text: "继续", replyToMessageId: 21 },
  ]);
  const original = await source.read(); const target = await createRuntimeEventLog(dir); const migrated = await target.read();
  assert.deepEqual(migrated.map(({ schemaVersion: _version, ...event }) => event), original.map(({ schemaVersion: _version, ...event }) => event));
  const report = await target.migrationReport(); assert.equal(report.referencesVerified, true); assert.ok(report.checkedReferences >= 6);
  assert.deepEqual(await target.loadArchive(archive), result);
  assert.deepEqual(await source.read(), original);
});

test("migration preserves JSONL identities and rejects an altered source after handover", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jsonl-migration-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.jsonl");
  const body = JSON.stringify({ type: "message", at: "2026-10-05T00:00:00.000Z", role: "user", chatId: 42, text: "旧消息" }) + "\n";
  await writeFile(path, body);
  const migrated = await createRuntimeEventLog(dir);
  assert.match(String((await migrated.read())[0]!.eventId), /^event:0:/);
  assert.equal(await readFile(path, "utf8"), body);
  await writeFile(path, body + JSON.stringify({ type: "reset", at: "2026-10-05T00:00:01.000Z" }) + "\n");
  await assert.rejects(createRuntimeEventLog(dir), /旧事实源已变化/);
});
