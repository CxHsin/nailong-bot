import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eventIdentity } from "./memory-facts.js";
import { createSqliteRuntimeLog } from "./sqlite-runtime-log.js";
import type { StoredEvent, ToolArchive } from "./runtime-types.js";
import { validateMigrationAssociations, type MigrationAssociations } from "./migration-validation.js";
import { validateRuntimeFact } from "./event-schema.js";

export type MigrationReport = MigrationAssociations & { schemaVersion: number; count: number; sourceDigest: string;
  identitiesPreserved: boolean; referencesPreserved: boolean; originalRetained: boolean };

export const RUNTIME_SCHEMA_VERSION = 2;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function exists(path: string) {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function legacySnapshot(dataDir: string): Promise<StoredEvent[]> {
  const databases = [];
  for (const name of ["events.sqlite", "runtime.sqlite"]) if (await exists(join(dataDir, name))) databases.push(join(dataDir, name));
  if (databases.length > 1) throw new Error("发现多个旧事件库，需明确唯一事实源后迁移");
  const path = databases[0];
  if (path) {
    const source = new DatabaseSync(path, { readOnly: true });
    try {
      source.exec("BEGIN");
      const rows = source.prepare("SELECT sequence, event_id, schema_version, session_id, payload FROM runtime_events ORDER BY sequence").all();
      return rows.map((row) => ({ ...JSON.parse(String(row.payload)), eventId: row.event_id,
        sequence: row.sequence, schemaVersion: row.schema_version, sessionId: row.session_id }));
    } finally { source.close(); }
  }
  const jsonPath = join(dataDir, "events.jsonl");
  if (!await exists(jsonPath)) return [];
  const text = await readFile(jsonPath, "utf8");
  if (text && !text.endsWith("\n")) throw new Error("旧日志末行不完整，不能切换事实源");
  return text.split("\n").filter(Boolean).map((line, index) => {
    const event = JSON.parse(line) as StoredEvent;
    return { ...event, eventId: eventIdentity(event, index), sequence: index + 1 };
  });
}

/** Open only after the legacy writer has stopped. Source files are never rewritten. */
export async function createRuntimeEventLog(dataDir: string) {
  await mkdir(dataDir, { recursive: true });
  const log = createSqliteRuntimeLog(dataDir, { fileName: "runtime-v2.sqlite", schemaVersion: RUNTIME_SCHEMA_VERSION, validate: validateRuntimeFact });
  await log.read(); // Initialize the destination schema, not its source.
  const target = new DatabaseSync(join(dataDir, "runtime-v2.sqlite"));
  try {
    target.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS runtime_migrations (source_digest TEXT NOT NULL, event_count INTEGER NOT NULL, report TEXT NOT NULL)");
    const migration = target.prepare("SELECT source_digest FROM runtime_migrations").get();
    if (migration) {
      if (migration.source_digest !== digest(await legacySnapshot(dataDir))) throw new Error("保留的旧事实源已变化，不能混用新旧 writer");
    } else {
      const source = await legacySnapshot(dataDir);
      const associations = validateMigrationAssociations(source);
      for (const event of source) if (event.archive) await log.loadArchive(event.archive as ToolArchive);
      const converted = source.map((event) => {
        if (typeof event.type !== "string" || !Number.isFinite(Date.parse(event.at))) throw new Error("旧事件类型或时间无效");
        return event.type === "text_finalized" && ["progress", "status"].includes(String(event.contentKind))
          ? { ...event, contextPolicy: "include", source: "execution" } : event;
      });
      if (new Set(source.map((event) => event.eventId)).size !== source.length) throw new Error("旧事件身份重复");
      target.exec("BEGIN IMMEDIATE");
      try {
        if (target.prepare("SELECT COUNT(*) AS count FROM runtime_events").get()!.count !== 0)
          throw new Error("目标库已有未验证内容，不能自动覆盖");
        const insert = target.prepare(`INSERT INTO runtime_events (sequence,event_id,schema_version,session_id,request_id,model_step_id,text_segment_id,tool_call_id,kind,content_kind,payload) VALUES (?,?,2,?,?,?,?,?,?,?,?)`);
        for (const event of converted) {
          const { eventId, sequence, schemaVersion: _version, ...payload } = event;
          insert.run(Number(sequence), String(eventId), String(event.sessionId ?? "owner"),
            typeof event.requestId === "string" ? event.requestId : null,
            typeof event.modelStepId === "string" ? event.modelStepId : null,
            typeof event.textSegmentId === "string" ? event.textSegmentId : null,
            typeof event.toolCallId === "string" ? event.toolCallId : null, event.type,
            typeof event.contentKind === "string" ? event.contentKind : null, JSON.stringify(payload));
        }
        const copied = target.prepare("SELECT sequence,event_id,payload FROM runtime_events ORDER BY sequence").all();
        if (copied.length !== source.length || copied.some((row, index) => {
          const event = converted[index]!;
          const { eventId, sequence, schemaVersion: _version, ...payload } = event;
          return row.event_id !== eventId || row.sequence !== sequence || digest(JSON.parse(String(row.payload))) !== digest(payload);
        })) throw new Error("迁移内容或身份校验失败");
        // Detect a source changed while conversion ran, before committing the handover.
        if (digest(await legacySnapshot(dataDir)) !== digest(source)) throw new Error("旧事实源仍在变化，请停止旧 writer 后迁移");
        const report: MigrationReport = { ...associations, schemaVersion: 2, count: source.length, sourceDigest: digest(source),
          identitiesPreserved: true, referencesPreserved: true, originalRetained: true };
        target.prepare("INSERT INTO runtime_migrations VALUES (?,?,?)").run(digest(source), source.length, JSON.stringify(report));
        target.exec("COMMIT");
      } catch (error) { target.exec("ROLLBACK"); throw error; }
    }
  } finally { target.close(); }
  return { ...log, async migrationReport(): Promise<MigrationReport> {
    const db = new DatabaseSync(join(dataDir, "runtime-v2.sqlite"), { readOnly: true });
    try { return JSON.parse(String(db.prepare("SELECT report FROM runtime_migrations").get()!.report)); }
    finally { db.close(); }
  } };
}
