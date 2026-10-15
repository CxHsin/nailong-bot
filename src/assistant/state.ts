import { createHash } from "node:crypto";
import { readFile, access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HelperRecord } from "./herdr.js";
import type { QueueInput } from "./queue.js";

export type SteerRecord = {
  key: string;
  input: QueueInput;
  targetBatch: string;
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
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
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
  finishOutput(id: string, status: "sent" | "unknown") {
    this.db.prepare("UPDATE outputs SET status=? WHERE id=?").run(status,id);
  }
  async importHelpers(legacyDir?: string) {
    if (!legacyDir) return;
    const source = resolve(legacyDir);
    const marker = `helpers-imported:${source}`;
    if (this.db.prepare("SELECT value FROM metadata WHERE key=?").get(marker)) return;
    let index: {version: number; conversations: Array<{id:string;cwd:string}>};
    try { index = JSON.parse(await readFile(join(source, "conversations.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (index.version !== 1 || !Array.isArray(index.conversations)) throw new Error("旧帮手索引损坏；先核对旧目录");
    for (const item of index.conversations) {
      const hash = createHash("sha256").update(item.id).digest("hex");
      let saved: {version:number;helpers:HelperRecord[]};
      try { saved = JSON.parse(await readFile(join(source, "sessions", hash, "helpers.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (saved.version !== 1 || !Array.isArray(saved.helpers)) throw new Error("旧帮手记录损坏；先核对原委派");
      this.conversation(item.id, item.cwd);
      const existing = this.helpers(item.id);
      for (const helper of saved.helpers) {
        if (!existing.some((known) => known.id === helper.id)) existing.push({ ...helper, notice: undefined });
      }
      this.saveHelpers(item.id, existing);
    }
    this.db.prepare("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(marker, "1");
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
  if (oldNamespace) throw new Error("该目录属于旧 Pi 会话；请把 ASSISTANT_DATA_DIR 指向独立新目录。旧历史不会导入，委派身份可通过 ASSISTANT_LEGACY_DATA_DIR 读回。");
}

export function steerKey(input: QueueInput) {
  return `steer:${createHash("sha256").update(JSON.stringify([input.conversationId, input.source ?? "telegram", input.inputId])).digest("hex")}`;
}
