import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";

test("SQLite log commits ordered batches with stable identities across readers and restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const [first, second] = await log.appendBatch([
    { type: "request_started", requestId: "request-1" },
    { type: "text_snapshot", requestId: "request-1", modelStepId: "step-1",
      textSegmentId: "text-1", text: "先检查现状" },
  ]);
  const [third] = await Promise.all([
    log.append({ type: "tool_dispatch", requestId: "request-1", toolCallId: "call-1" }),
    createSqliteRuntimeLog(dir).append({ type: "tool_dispatch", requestId: "request-1", toolCallId: "call-2" }),
  ]);
  const reopened = createSqliteRuntimeLog(dir);
  const events = await reopened.read();
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 4);
  assert.deepEqual(events.slice(0, 2), [first, second]);
  assert.ok(events.some((event) => event.eventId === third.eventId));
  assert.deepEqual(await reopened.read(2), events.slice(2));
  assert.equal(events[1]?.schemaVersion, 1);
  assert.equal(events[1]?.textSegmentId, "text-1");
  assert.equal(events[1]?.sessionId, "owner");
});

test("a failed SQLite batch exposes no partial prefix or allocated sequence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-batch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  await assert.rejects(log.appendBatch([
    { type: "request_started", requestId: "request-1" },
    { type: "", requestId: "request-1" },
  ]));
  assert.deepEqual(await createSqliteRuntimeLog(dir).read(), []);
  const event = await log.append({ type: "request_started", requestId: "request-1" });
  assert.equal(event.sequence, 1);
});

test("a database failure after one valid insertion rolls back the whole batch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-fault-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  await log.read();
  const db = new DatabaseSync(join(dir, "events.sqlite"));
  db.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON runtime_events
    WHEN NEW.kind = 'reject_second' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  db.close();
  await assert.rejects(log.appendBatch([
    { type: "request_started", requestId: "r1" },
    { type: "reject_second", requestId: "r1" },
  ]), /injected failure/);
  assert.deepEqual(await createSqliteRuntimeLog(dir).read(), []);
  assert.equal((await log.append({ type: "request_started", requestId: "r1" })).sequence, 1);
});

test("legacy import preserves payload and source, and repeats without duplicates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "events.jsonl");
  const legacy = [
    { type: "message", at: "2026-01-01T00:00:00.000Z", role: "user", text: "查文件", requestId: "r1" },
    { type: "request_started", at: "2026-01-01T00:00:01.000Z", requestId: "r1" },
    { type: "tool_dispatch", at: "2026-01-01T00:00:02.000Z", requestId: "r1", toolCallId: "c1", toolName: "read" },
    { type: "tool_result", at: "2026-01-01T00:00:03.000Z", requestId: "r1", toolCallId: "c1", toolName: "read",
      archive: { path: "tool-results/a.txt", sha256: "abc" }, result: { content: [], details: {}, isError: false } },
    { type: "request_completed", at: "2026-01-01T00:00:04.000Z", requestId: "r1" },
  ];
  const original = legacy.map((event) => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(source, original);
  const log = createSqliteRuntimeLog(dir);
  await log.importLegacy();
  const first = await log.read();
  await createSqliteRuntimeLog(dir).importLegacy();
  assert.deepEqual(await log.read(), first);
  assert.deepEqual(first.map(({ sequence, eventId, schemaVersion, sessionId, ...payload }) => payload), legacy);
  assert.equal(await readFile(source, "utf8"), original);
});

test("invalid legacy input cannot expose a partial import", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "events.jsonl");
  const original = [
    JSON.stringify({ type: "request_started", at: "2026-01-01T00:00:00.000Z", requestId: "r1" }),
    JSON.stringify({ type: "tool_result", at: "2026-01-01T00:00:01.000Z", requestId: "r1",
      toolCallId: "never-dispatched", toolName: "read" }),
  ].join("\n") + "\n";
  await writeFile(source, original);
  const log = createSqliteRuntimeLog(dir);
  await assert.rejects(log.importLegacy());
  assert.deepEqual(await log.read(), []);
  assert.equal(await readFile(source, "utf8"), original);
  await writeFile(source, original + "{");
  await assert.rejects(log.importLegacy());
  assert.deepEqual(await log.read(), []);
});

test("legacy import rejects missing required fields and a changed source", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "events.jsonl");
  const log = createSqliteRuntimeLog(dir);
  await writeFile(source, JSON.stringify({ type: "message", at: "2026-01-01T00:00:00.000Z", role: "user" }) + "\n");
  await assert.rejects(log.importLegacy());
  assert.deepEqual(await log.read(), []);
  await writeFile(source, JSON.stringify({ type: "message", at: "2026-01-01T00:00:00.000Z",
    role: "user", text: "hello" }) + "\n");
  await log.importLegacy();
  const imported = await log.read();
  await writeFile(source, JSON.stringify({ type: "message", at: "2026-01-01T00:00:00.000Z",
    role: "user", text: "changed" }) + "\n");
  await assert.rejects(log.importLegacy());
  assert.deepEqual(await log.read(), imported);
});

for (const [name, legacy] of [
  ["unknown event kind", [{ type: "mystery", at: "2026-01-01T00:00:00Z" }]],
  ["model step completion without start", [
    { type: "request_started", requestId: "r1", at: "2026-01-01T00:00:00Z" },
    { type: "model_step_completed", requestId: "r1", step: 1, at: "2026-01-01T00:00:01Z" },
  ]],
  ["tool dispatch after request completion", [
    { type: "request_started", requestId: "r1", at: "2026-01-01T00:00:00Z" },
    { type: "request_completed", requestId: "r1", at: "2026-01-01T00:00:01Z" },
    { type: "tool_dispatch", requestId: "r1", toolCallId: "c1", toolName: "read", at: "2026-01-01T00:00:02Z" },
  ]],
] as const) {
  test(`legacy import rejects ${name}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-lifecycle-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "events.jsonl"), legacy.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const log = createSqliteRuntimeLog(dir);
    await assert.rejects(log.importLegacy());
    assert.deepEqual(await log.read(), []);
  });
}
