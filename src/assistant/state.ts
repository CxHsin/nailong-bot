import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HelperRecord } from "./herdr.js";
import type { QueueInput } from "./queue.js";
import type { HelperControlRecord } from "./helper-control.js";

export type SteerRecord = {
  key: string;
  input: QueueInput;
  targetBatch: string;
  eventId?: string;
  actionId?: string;
  targetId?: string;
  submissionId?: string;
  state: "pending" | "submitted" | "handled";
};

export class AssistantState {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir, "assistant.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS helpers(conversation TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(conversation,id));
      CREATE TABLE IF NOT EXISTS steers(key TEXT PRIMARY KEY,conversation TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outputs(id TEXT PRIMARY KEY,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS helper_controls(conversation TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(conversation,id));
      CREATE TABLE IF NOT EXISTS output_targets(conversation TEXT NOT NULL,id TEXT NOT NULL,targets TEXT NOT NULL,PRIMARY KEY(conversation,id));
      CREATE TABLE IF NOT EXISTS reply_targets(conversation TEXT NOT NULL,message TEXT NOT NULL,targets TEXT NOT NULL,PRIMARY KEY(conversation,message));`);
  }
  conversation(id: string, cwd: string) {
    this.db.prepare("INSERT OR IGNORE INTO conversations VALUES(?,?)").run(id, cwd);
    return (this.db.prepare("SELECT cwd FROM conversations WHERE id=?").get(id) as { cwd: string }).cwd;
  }
  conversations() { return this.db.prepare("SELECT id,cwd FROM conversations").all() as Array<{id: string; cwd: string}>; }
  helpers(id: string) {
    return (this.db.prepare("SELECT payload FROM helpers WHERE conversation=? ORDER BY rowid").all(id) as Array<{payload:string}>)
      .map((row) => JSON.parse(row.payload) as HelperRecord);
  }
  saveHelpers(id: string, helpers: HelperRecord[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const save = this.db.prepare("INSERT OR REPLACE INTO helpers VALUES(?,?,?)");
      for (const helper of helpers) save.run(id, helper.id, JSON.stringify(helper));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  storeSteer(value: SteerRecord) {
    this.db.prepare("INSERT OR REPLACE INTO steers VALUES(?,?,?)").run(value.key, value.input.conversationId, JSON.stringify(value));
  }
  steer(key: string) {
    const row = this.db.prepare("SELECT payload FROM steers WHERE key=?").get(key) as {payload:string} | undefined;
    return row ? JSON.parse(row.payload) as SteerRecord : undefined;
  }
  pendingSteers(id?: string) {
    const rows = id
      ? this.db.prepare("SELECT payload FROM steers WHERE conversation=? ORDER BY rowid").all(id)
      : this.db.prepare("SELECT payload FROM steers ORDER BY rowid").all();
    return (rows as Array<{payload:string}>).map((row) => JSON.parse(row.payload) as SteerRecord).filter((item) => item.state !== "handled");
  }
  beginOutput(id: string) {
    return this.db.prepare("INSERT OR IGNORE INTO outputs VALUES(?,'sending')").run(id).changes > 0;
  }
  helperControl(conversation: string, id: string): HelperControlRecord | undefined {
    const row = this.db.prepare("SELECT payload FROM helper_controls WHERE conversation=? AND id=?").get(conversation,id) as {payload:string}|undefined;
    return row && JSON.parse(row.payload);
  }
  saveHelperControl(conversation: string, record: HelperControlRecord) {
    this.db.prepare("INSERT OR REPLACE INTO helper_controls VALUES(?,?,?)").run(conversation,record.id,JSON.stringify(record));
  }
  helperControls(conversation: string): HelperControlRecord[] {
    return (this.db.prepare("SELECT payload FROM helper_controls WHERE conversation=? ORDER BY rowid").all(conversation) as Array<{payload:string}>).map(row=>JSON.parse(row.payload));
  }
  saveOutputTargets(conversation: string, id: string, targets: string[]) {
    this.db.prepare("INSERT OR REPLACE INTO output_targets VALUES(?,?,?)").run(conversation,id,JSON.stringify(targets));
  }
  recordReply(conversation: string, message: string, outputId: string) {
    const row = this.db.prepare("SELECT targets FROM output_targets WHERE conversation=? AND id=?").get(conversation,outputId) as {targets:string}|undefined;
    if (row) this.db.prepare("INSERT OR REPLACE INTO reply_targets VALUES(?,?,?)").run(conversation,message,row.targets);
  }
  replyTargets(conversation: string, message: string): string[] {
    const row = this.db.prepare("SELECT targets FROM reply_targets WHERE conversation=? AND message=?").get(conversation,message) as {targets:string}|undefined;
    return row ? JSON.parse(row.targets) : [];
  }
  finishOutput(id: string, status: "sent" | "unknown") {
    this.db.prepare("UPDATE outputs SET status=? WHERE id=?").run(status,id);
  }
  close() { this.db.close(); }
}

export async function requireFreshNamespace(dataDir: string) {
  const exists = async (path: string) => {
    try { await access(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  let oldNamespace = await exists(join(dataDir,"conversations.json"));
  const sessions = join(dataDir,"sessions");
  if (await exists(sessions)) {
    for (const entry of await readdir(sessions,{withFileTypes:true})) {
      if (entry.isDirectory() && await exists(join(sessions,entry.name,"session.json"))) oldNamespace = true;
    }
  }
  if (oldNamespace) throw new Error("该目录属于旧 Pi 会话；请把 ASSISTANT_DATA_DIR 指向独立新目录。");
}

export function steerKey(input: QueueInput) {
  return `steer:${createHash("sha256").update(JSON.stringify([input.conversationId, input.source ?? "telegram", input.inputId])).digest("hex")}`;
}
