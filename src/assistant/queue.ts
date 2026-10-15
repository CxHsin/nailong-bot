import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ImageContent } from "@mariozechner/pi-ai";

export type QueueInput = {
  conversationId: string;
  inputId: string;
  text: string;
  images?: ImageContent[];
  source?: string;
  priority?: number;
  kind?: "message" | "command" | "internal";
};
export type PersistedInput = QueueInput & {
  eventId: string;
  sequence: number;
  source: string;
  priority: number;
  kind: "message" | "command" | "internal";
};
export type BatchStatus = "running" | "preempted" | "paused" | "needs_confirmation" | "completed";
export type ProcessingBatch = {
  id: string;
  requestKey: string;
  conversationId: string;
  events: PersistedInput[];
  submissionId?: string;
  previousSubmissionId?: string;
  resumed: boolean;
  reconcile: boolean;
  retryEpoch?: number;
};
export type StoredBatch = ProcessingBatch & { status: BatchStatus; reason?: string };
type BatchRow = { id: string; conversation: string; request_key: string; status: BatchStatus; submission: string | null; previous_submission: string | null; priority: number; attempt: number; reconcile: number; retry_epoch?: number; reason?: string|null };

export function inputPriority(input: QueueInput) {
  const source = input.source ?? (input.conversationId.startsWith("telegram:") ? "telegram" : "cli");
  return input.priority ?? (["telegram", "cli", "user", "direct"].includes(source) ? 100 : 0);
}

/** Input and fixed batch membership are committed before the channel acknowledges receipt. */
export class PersistentAssistantQueue {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS inputs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        conversation TEXT NOT NULL, source TEXT NOT NULL, input_id TEXT NOT NULL,
        priority INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        batch_id TEXT, UNIQUE(conversation, source, input_id));
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY, conversation TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE,
        priority INTEGER NOT NULL, status TEXT NOT NULL, submission TEXT, reason TEXT,
        previous_submission TEXT, attempt INTEGER NOT NULL DEFAULT 0, reconcile INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS internal_results (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        conversation TEXT NOT NULL, source TEXT NOT NULL, input_id TEXT NOT NULL,
        priority INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        batch_id TEXT, UNIQUE(conversation, source, input_id));
      CREATE INDEX IF NOT EXISTS waiting_inputs ON inputs(conversation, batch_id, sequence);`);
    const columns = this.db.prepare("PRAGMA table_info(batches)").all() as Array<{name: string}>;
    if (!columns.some((column) => column.name === "retry_epoch")) this.db.exec("ALTER TABLE batches ADD COLUMN retry_epoch INTEGER NOT NULL DEFAULT 0");
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  receive(input: QueueInput) { return this.store(input, "inputs"); }
  receiveInternal(input: QueueInput) { return this.store({ ...input, source: input.source ?? "herdr", kind: "internal", priority: input.priority ?? 0 }, "internal_results"); }
  private store(input: QueueInput, table: "inputs" | "internal_results") {
    const source = input.source ?? (input.conversationId.startsWith("telegram:") ? "telegram" : "cli");
    const priority = inputPriority(input);
    if (!Number.isFinite(priority)) throw new Error("Input priority must be finite");
    const kind = input.kind ?? (input.text.trimStart().startsWith("/") ? "command" : "message");
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT id FROM ${table} WHERE conversation=? AND source=? AND input_id=?`)
        .get(input.conversationId, source, input.inputId) as { id: string } | undefined;
      if (existing) return { accepted: false, duplicate: true, eventId: existing.id };
      const eventId = randomUUID();
      this.db.prepare(`INSERT INTO ${table}(id,conversation,source,input_id,priority,kind,payload) VALUES(?,?,?,?,?,?,?)`)
        .run(eventId, input.conversationId, source, input.inputId, priority, kind, JSON.stringify({ ...input, source, priority, kind }));
      if (table === "inputs") {
        // Persist the interruption decision with receipt, before the cooperative abort can run.
        this.db.prepare("UPDATE batches SET status='preempted' WHERE conversation=? AND status='running' AND priority<?")
          .run(input.conversationId, priority);
      }
      return { accepted: true, duplicate: false, eventId };
    });
  }
  conversations(): string[] {
    return (this.db.prepare("SELECT conversation FROM inputs UNION SELECT conversation FROM internal_results").all() as Array<{conversation: string}>)
      .map((row) => row.conversation);
  }
  private hydrate(row: BatchRow, resumed: boolean): ProcessingBatch {
    const inputs = this.db.prepare("SELECT id,sequence,payload FROM inputs WHERE batch_id=? UNION ALL SELECT id,sequence,payload FROM internal_results WHERE batch_id=? ORDER BY sequence")
      .all(row.id,row.id) as Array<{ id: string; sequence: number; payload: string }>;
    return { id: row.id, requestKey: row.request_key, conversationId: row.conversation,
      events: inputs.map((event) => ({ ...JSON.parse(event.payload), eventId: event.id, sequence: event.sequence })),
      submissionId: row.submission === null ? undefined : String(row.submission),
      previousSubmissionId: row.previous_submission === null ? undefined : String(row.previous_submission),
      resumed, reconcile: Boolean(row.reconcile), retryEpoch: row.retry_epoch ?? 0 };
  }
  claim(conversationId: string): ProcessingBatch | undefined {
    return this.transaction(() => {
      const interrupted = this.db.prepare("SELECT * FROM batches WHERE conversation=? AND status IN ('running','preempted') ORDER BY priority DESC, rowid LIMIT 1")
        .get(conversationId) as BatchRow | undefined;
      const head = this.db.prepare("SELECT sequence,priority,source,kind,'inputs' AS origin FROM inputs WHERE conversation=? AND batch_id IS NULL UNION ALL SELECT sequence,priority,source,kind,'internal_results' AS origin FROM internal_results WHERE conversation=? AND batch_id IS NULL ORDER BY priority DESC, sequence LIMIT 1")
        .get(conversationId,conversationId) as { sequence: number; priority: number; source: string; kind: string; origin: string } | undefined;
      if (interrupted && (!head || interrupted.priority >= head.priority)) {
        if (interrupted.status === "preempted") {
          interrupted.attempt++;
          interrupted.request_key = `batch:${interrupted.id}:${interrupted.attempt}`;
          interrupted.previous_submission = interrupted.submission ?? interrupted.previous_submission;
          interrupted.submission = null;
          interrupted.reconcile = 1;
          interrupted.status = "running";
          this.db.prepare("UPDATE batches SET attempt=?,request_key=?,previous_submission=?,submission=NULL,reconcile=1,status='running' WHERE id=?")
            .run(interrupted.attempt, interrupted.request_key, interrupted.previous_submission, interrupted.id);
        }
        return this.hydrate(interrupted, true);
      }
      if (!head) return undefined;
      const pending = this.db.prepare(`SELECT id,sequence,source,priority,kind FROM ${head.origin} WHERE conversation=? AND batch_id IS NULL AND sequence>=? ORDER BY sequence`)
        .all(conversationId, head.sequence) as Array<{ id: string; sequence: number; source: string; priority: number; kind: string }>;
      const members: string[] = [];
      for (const event of pending) {
        if (members.length && (head.kind !== "message" || event.kind !== "message" || event.source !== head.source || event.priority !== head.priority)) break;
        members.push(event.id);
        if (head.kind !== "message") break;
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO batches(id,conversation,request_key,priority,status) VALUES(?,?,?,?,'running')")
        .run(id, conversationId, `batch:${id}`, head.priority);
      const assign = this.db.prepare(`UPDATE ${head.origin} SET batch_id=? WHERE id=?`);
      for (const member of members) assign.run(id, member);
      return this.hydrate({ id, conversation: conversationId, request_key: `batch:${id}`, priority: head.priority,
        status: "running", submission: null, previous_submission: null, attempt: 0, reconcile: 0 }, false);
    });
  }
  recordSubmission(batchId: string, submissionId: string) {
    this.db.prepare("UPDATE batches SET submission=? WHERE id=?").run(submissionId, batchId);
  }
  getBatch(batchId: string): StoredBatch | undefined {
    const row = this.db.prepare("SELECT * FROM batches WHERE id=?").get(batchId) as BatchRow|undefined;
    return row ? {...this.hydrate(row,true),status:row.status,reason:row.reason??undefined} : undefined;
  }
  listBatches(conversationId?: string, statuses?: BatchStatus[]): StoredBatch[] {
    const rows = (conversationId
      ? this.db.prepare("SELECT * FROM batches WHERE conversation=? ORDER BY rowid").all(conversationId)
      : this.db.prepare("SELECT * FROM batches ORDER BY rowid").all()) as BatchRow[];
    return rows.filter((row)=>!statuses||statuses.includes(row.status))
      .map((row)=>({...this.hydrate(row,true),status:row.status,reason:row.reason??undefined}));
  }
  listPending(conversationId?: string): PersistedInput[] {
    const rows = (conversationId
      ? this.db.prepare("SELECT id,sequence,payload FROM inputs WHERE batch_id IS NULL AND conversation=? ORDER BY sequence").all(conversationId)
      : this.db.prepare("SELECT id,sequence,payload FROM inputs WHERE batch_id IS NULL ORDER BY sequence").all()) as Array<{id:string;sequence:number;payload:string}>;
    return rows.map((row)=>({...JSON.parse(row.payload),eventId:row.id,sequence:row.sequence}));
  }
  settle(batchId: string, status: Exclude<BatchStatus, "running">, reason?: string) {
    this.db.prepare("UPDATE batches SET status=?,reason=? WHERE id=?").run(status, reason ?? null, batchId);
  }
  recoverSteerTarget(batchId: string) {
    this.db.prepare("UPDATE batches SET status='running' WHERE id=? AND status='completed'").run(batchId);
  }
  resume(conversationId: string, batchId?: string) {
    if (batchId) this.db.prepare("UPDATE batches SET status='preempted',retry_epoch=retry_epoch+1 WHERE id=? AND conversation=? AND status IN ('paused','needs_confirmation')").run(batchId, conversationId);
    else this.db.prepare("UPDATE batches SET status='preempted',retry_epoch=retry_epoch+1 WHERE conversation=? AND status IN ('paused','needs_confirmation')").run(conversationId);
  }
  close() { this.db.close(); }
}
