import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";

test("offline migration command backs up source and derived files without calling models or sending messages", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "migration-command-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = createSqliteRuntimeLog(dir);
  await source.append({ type: "message", role: "user", requestId: "old", chatId: 42, text: "历史" });
  await writeFile(join(dir, "runtime.sqlite"), "");
  await writeFile(join(dir, "cache-example.json"), '{"derived":true}');
  const before = await source.read();
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli/migrate-runtime.ts", import.meta.url))], {
    env: { ...process.env, AGENT_DATA_DIR: dir, DEEPSEEK_API_KEY: "", TELEGRAM_BOT_TOKEN: "", AGENT_TELEGRAM_BOT_TOKEN: "" },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.migratedEvents, 1); assert.equal(report.modelsInvoked, 0); assert.equal(report.messagesSent, 0);
  assert.deepEqual(await source.read(), before);
  assert.deepEqual(await createSqliteRuntimeLog(report.backupDir).read(), before);
  assert.equal(await readFile(join(report.backupDir, "cache-example.json"), "utf8"), '{"derived":true}');
  const manifest = JSON.parse(await readFile(join(report.backupDir, "backup-manifest.json"), "utf8"));
  assert.ok(manifest.files.some((file: { path: string; sha256: string }) => file.path === "events.sqlite" && file.sha256.length === 64));
  assert.equal((await (await createRuntimeEventLog(dir)).read()).length, 1);
});

test("startup migrates a real history beside an empty placeholder and retained JSONL prefix", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "migration-empty-store-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = createSqliteRuntimeLog(dir);
  const input = { type: "message", at: "2026-10-05T00:00:00.000Z", role: "user", requestId: "old", chatId: 42, text: "旧内容" };
  await source.append(input);
  await source.append({ type: "message", role: "user", requestId: "new", chatId: 42, text: "后续内容" });
  await writeFile(join(dir, "runtime.sqlite"), "");
  const json = JSON.stringify(input) + "\n"; await writeFile(join(dir, "events.jsonl"), json);
  const before = await source.read(); const target = await createRuntimeEventLog(dir);
  assert.deepEqual((await target.read()).map((event) => event.eventId), before.map((event) => event.eventId));
  assert.deepEqual((await target.migrationReport()).sources?.map((source) => [source.file, source.count, source.disposition]),
    [["events.sqlite", 2, "primary"], ["runtime.sqlite", 0, "empty"], ["events.jsonl", 1, "prefix"]]);
  assert.equal((await readFile(join(dir, "runtime.sqlite"))).length, 0);
  assert.equal(await readFile(join(dir, "events.jsonl"), "utf8"), json);
  assert.deepEqual(await source.read(), before);
  await writeFile(join(dir, "events.jsonl"), json + JSON.stringify({ ...input, text: "未包含的新历史" }) + "\n");
  await assert.rejects(createRuntimeEventLog(dir), /不同历史/);
});

test("startup migrates duplicate legacy databases without dropping or modifying either source", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "migration-two-stores-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = createSqliteRuntimeLog(dir);
  await source.append({ type: "message", role: "user", requestId: "old", chatId: 42, text: "保留历史" });
  await copyFile(join(dir, "events.sqlite"), join(dir, "runtime.sqlite"));
  const before = await source.read();
  const target = await createRuntimeEventLog(dir);
  assert.deepEqual((await target.read()).map((event) => event.eventId), before.map((event) => event.eventId));
  assert.deepEqual(await source.read(), before);
  assert.deepEqual(await createSqliteRuntimeLog(dir, { fileName: "runtime.sqlite" }).read(), before);
  assert.equal((await (await createRuntimeEventLog(dir)).read()).length, 1);
});

test("migration chooses the complete identity prefix and rejects a divergent second writer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "migration-prefix-store-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = createSqliteRuntimeLog(dir);
  await source.append({ type: "message", role: "user", requestId: "old", chatId: 42, text: "历史" });
  await copyFile(join(dir, "events.sqlite"), join(dir, "runtime.sqlite"));
  const other = createSqliteRuntimeLog(dir, { fileName: "runtime.sqlite" });
  await other.append({ type: "message", role: "user", requestId: "new", chatId: 42, text: "完整历史" });
  const target = await createRuntimeEventLog(dir);
  assert.deepEqual((await target.read()).map((event) => event.eventId), (await other.read()).map((event) => event.eventId));
  assert.equal((await target.migrationReport()).sources?.find((source) => source.file === "events.sqlite")?.disposition, "prefix");
  await source.append({ type: "message", role: "user", requestId: "different", chatId: 42, text: "分叉历史" });
  await assert.rejects(createRuntimeEventLog(dir), /不同历史/);
});

test("migration rejects unrelated histories, including a JSONL-only tail beside SQLite", async (t) => {
  for (const variant of ["sqlite", "jsonl"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "migration-conflicting-stores-")); t.after(() => rm(dir, { recursive: true, force: true }));
    const source = createSqliteRuntimeLog(dir);
    const input = { type: "message", at: "2026-10-05T00:00:00.000Z", role: "user", requestId: "old", text: "历史" };
    await source.append(input);
    if (variant === "sqlite") await createSqliteRuntimeLog(dir, { fileName: "runtime.sqlite" }).append(input); // Same text, distinct identities: unsafe to deduplicate.
    else await writeFile(join(dir, "events.jsonl"), JSON.stringify(input) + "\n" + JSON.stringify({ ...input, text: "只在 JSONL 的历史" }) + "\n");
    await assert.rejects(createRuntimeEventLog(dir), /不同历史/);
    assert.equal((await createSqliteRuntimeLog(dir, { fileName: "runtime-v2.sqlite" }).read()).length, 0);
  }
});

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
