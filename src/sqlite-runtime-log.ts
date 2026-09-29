import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredEvent } from "./runtime-log.js";

export type EventInput = Omit<StoredEvent, "at"> & { at?: string };
export type SqliteEvent = StoredEvent & {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  sessionId: string;
  modelStepId?: string;
  textSegmentId?: string;
  toolCallId?: string;
};

type EventRow = {
  sequence: number;
  event_id: string;
  schema_version: number;
  session_id: string;
  payload: string;
};

const reserved = new Set(["eventId", "sequence", "schemaVersion"]);
const legacyKinds = new Set([
  "message", "reset", "request_started", "request_completed", "request_failed",
  "request_interrupted", "model_step_started", "model_step_completed", "model_message",
  "tool_call", "tool_dispatch", "tool_result", "answer_generated",
  "delivery_chunk_succeeded", "delivery_succeeded", "delivery_failed", "delivery_unknown",
  "context_projected", "projection_failed", "provider_overflow",
]);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      request_id TEXT,
      model_step_id TEXT,
      text_segment_id TEXT,
      tool_call_id TEXT,
      kind TEXT NOT NULL,
      content_kind TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runtime_events_request ON runtime_events(request_id, sequence);
    CREATE INDEX IF NOT EXISTS runtime_events_text ON runtime_events(text_segment_id, sequence);
    CREATE TABLE IF NOT EXISTS legacy_imports (
      source_id TEXT PRIMARY KEY,
      source_sha256 TEXT NOT NULL,
      event_count INTEGER NOT NULL
    );
  `);
  return db;
}

function transact<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validateEvent(event: EventInput): void {
  if (!event || typeof event !== "object" || typeof event.type !== "string" || !event.type.trim()) {
    throw new Error("事件类型缺失");
  }
  if (Object.keys(event).some((key) => reserved.has(key))) throw new Error("事件身份只能由日志分配");
  for (const field of ["requestId", "sessionId", "modelStepId", "textSegmentId", "toolCallId"] as const) {
    if (event[field] !== undefined && (typeof event[field] !== "string" || !event[field])) {
      throw new Error(`事件关联字段无效：${field}`);
    }
  }
  if (event.at !== undefined && (typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at)))) {
    throw new Error("事件时间无效");
  }
}

function insert(db: DatabaseSync, input: EventInput, eventId: string): SqliteEvent {
  validateEvent(input);
  const event = { ...input, at: input.at ?? new Date().toISOString() } as StoredEvent;
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "owner";
  const result = db.prepare(`INSERT INTO runtime_events
    (event_id, schema_version, session_id, request_id, model_step_id, text_segment_id,
     tool_call_id, kind, content_kind, payload) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    eventId, sessionId, typeof input.requestId === "string" ? input.requestId : null,
    typeof input.modelStepId === "string" ? input.modelStepId : null,
    typeof input.textSegmentId === "string" ? input.textSegmentId : null,
    typeof input.toolCallId === "string" ? input.toolCallId : null,
    event.type, typeof input.contentKind === "string" ? input.contentKind : null,
    JSON.stringify(event),
  );
  return { ...event, schemaVersion: 1, eventId, sequence: Number(result.lastInsertRowid), sessionId };
}

function validateLegacy(events: StoredEvent[]): void {
  const started = new Set<string>();
  const ended = new Set<string>();
  const dispatch = new Set<string>();
  const results = new Set<string>();
  const answers = new Set<string>();
  const steps = new Map<string, Set<number>>();
  let previousTime = -Infinity;
  for (const event of events) {
    validateEvent(event);
    if (!event.at) throw new Error("旧日志缺少事件时间");
    if (!legacyKinds.has(event.type)) throw new Error("旧日志包含未知事件类型");
    if (event.type === "message" &&
      (!(["user", "assistant"] as unknown[]).includes(event.role) || typeof event.text !== "string")) {
      throw new Error("旧日志消息缺少角色或文本");
    }
    if (["model_step_started", "model_step_completed"].includes(event.type) &&
      (!Number.isSafeInteger(event.step) || Number(event.step) <= 0)) {
      throw new Error("旧日志模型步骤编号无效");
    }
    if (event.type === "model_message" &&
      (!event.message || typeof event.message !== "object")) {
      throw new Error("旧日志模型消息缺失");
    }
    if (event.type === "delivery_chunk_succeeded" &&
      (!Number.isSafeInteger(event.index) || !Number.isSafeInteger(event.total) ||
        Number(event.index) < 1 || Number(event.total) < Number(event.index))) {
      throw new Error("旧日志投递分段无效");
    }
    if (["model_step_started", "model_step_completed", "model_message", "tool_call",
      "tool_dispatch", "tool_result", "answer_generated", "delivery_chunk_succeeded",
      "delivery_succeeded", "delivery_failed", "delivery_unknown", "request_completed",
      "request_failed", "request_interrupted", "context_projected", "projection_failed",
      "provider_overflow"].includes(event.type) && !event.requestId) {
      throw new Error("旧日志事件缺少请求身份");
    }
    const time = Date.parse(event.at);
    if (time < previousTime) throw new Error("旧日志时间顺序倒退");
    previousTime = time;
    const requestId = event.requestId;
    if (requestId && ended.has(requestId)) throw new Error("旧日志请求结束后仍有事件");
    if (event.type === "model_step_started") {
      if (!requestId || !started.has(requestId)) throw new Error("旧日志模型步骤无对应请求");
      const open = steps.get(requestId) ?? new Set<number>();
      if (open.has(Number(event.step))) throw new Error("旧日志模型步骤重复开始");
      open.add(Number(event.step));
      steps.set(requestId, open);
    } else if (event.type === "model_step_completed") {
      const open = requestId ? steps.get(requestId) : undefined;
      if (!open?.delete(Number(event.step))) throw new Error("旧日志模型步骤无对应开始");
    }
    if (event.type === "request_started") {
      if (!requestId || started.has(requestId)) throw new Error("旧日志请求开始事件重复或缺少身份");
      started.add(requestId);
    } else if (["request_completed", "request_failed", "request_interrupted"].includes(event.type)) {
      if (!requestId || !started.has(requestId) || ended.has(requestId)) throw new Error("旧日志请求终态矛盾");
      if (event.type === "request_completed" && (steps.get(requestId)?.size ?? 0) > 0) {
        throw new Error("旧日志完成请求仍有未完成模型步骤");
      }
      ended.add(requestId);
    } else if (event.type === "tool_dispatch" || event.type === "tool_result") {
      if (!requestId || !started.has(requestId) || typeof event.toolCallId !== "string" ||
        !event.toolCallId || typeof event.toolName !== "string" || !event.toolName) {
        throw new Error("旧日志工具事件缺少关联身份");
      }
      const identity = `${requestId}\u0000${event.toolCallId}`;
      if (event.type === "tool_dispatch") {
        if (dispatch.has(identity)) throw new Error("旧日志工具派发重复");
        dispatch.add(identity);
      } else {
        if (!dispatch.has(identity) || results.has(identity)) throw new Error("旧日志工具结果无对应派发或重复");
        if (!event.result || typeof event.result !== "object" ||
          !Array.isArray((event.result as { content?: unknown }).content)) throw new Error("旧日志工具结果缺失");
        results.add(identity);
      }
    } else if (event.type === "answer_generated") {
      if (!requestId || !started.has(requestId) || typeof event.text !== "string") {
        throw new Error("旧日志回答事件无对应请求");
      }
      answers.add(requestId);
    } else if (event.type === "delivery_succeeded" && (!requestId || !answers.has(requestId))) {
      throw new Error("旧日志送达事件无对应回答");
    }
  }
}

export function createSqliteRuntimeLog(dataDir: string) {
  const databaseFile = join(dataDir, "events.sqlite");
  const legacyFile = join(dataDir, "events.jsonl");

  async function withDatabase<T>(work: (db: DatabaseSync) => T): Promise<T> {
    await mkdir(dataDir, { recursive: true });
    const db = openDatabase(databaseFile);
    try { return work(db); }
    finally { db.close(); }
  }

  return {
    async read(afterSequence = 0): Promise<SqliteEvent[]> {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("事件游标无效");
      return withDatabase((db) => {
        const rows = db.prepare(`SELECT sequence, event_id, schema_version, session_id, payload
          FROM runtime_events WHERE sequence > ? ORDER BY sequence`).all(afterSequence) as EventRow[];
        return rows.map((row) => ({ ...JSON.parse(row.payload) as StoredEvent,
          schemaVersion: row.schema_version as 1, eventId: row.event_id,
          sequence: row.sequence, sessionId: row.session_id }));
      });
    },
    async append(input: EventInput): Promise<SqliteEvent> {
      const [event] = await this.appendBatch([input]);
      return event!;
    },
    async appendBatch(inputs: EventInput[]): Promise<SqliteEvent[]> {
      return withDatabase((db) => transact(db, () => inputs.map((input) => insert(db, input, randomUUID()))));
    },
    async importLegacy(): Promise<number> {
      let source: string;
      try { source = await readFile(legacyFile, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
      if (source && !source.endsWith("\n")) throw new Error("旧日志末行不完整");
      const lines = source ? source.split("\n").slice(0, -1) : [];
      const events = lines.map((line) => JSON.parse(line) as StoredEvent);
      validateLegacy(events);
      const sourceId = sha256(resolve(legacyFile));
      const sourceDigest = sha256(source);
      return withDatabase((db) => transact(db, () => {
        const existing = db.prepare("SELECT source_sha256, event_count FROM legacy_imports WHERE source_id = ?")
          .get(sourceId) as { source_sha256: string; event_count: number } | undefined;
        if (existing) {
          if (existing.source_sha256 !== sourceDigest) throw new Error("已导入的旧日志内容发生变化");
          return existing.event_count;
        }
        events.forEach((event, index) => insert(db, event,
          `legacy:${sha256(`${sourceId}\u0000${index + 1}\u0000${lines[index]}`)}`));
        db.prepare("INSERT INTO legacy_imports (source_id, source_sha256, event_count) VALUES (?, ?, ?)")
          .run(sourceId, sourceDigest, events.length);
        return events.length;
      }));
    },
  };
}
