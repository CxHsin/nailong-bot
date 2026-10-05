import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eventIdentity } from "./memory-facts.js";
import type { StoredEvent } from "./runtime-types.js";

export type LegacySource = { file: string; count: number; digest: string; disposition: "primary" | "empty" | "duplicate" | "prefix" };
type Candidate = { file: string; events: StoredEvent[]; payloads: StoredEvent[] };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function exists(path: string) {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function sqliteCandidate(dataDir: string, file: string): Promise<Candidate> {
  const source = new DatabaseSync(join(dataDir, file), { readOnly: true });
  try {
    source.exec("BEGIN");
    const tables = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (!tables.length) return { file, events: [], payloads: [] }; // Empty SQLite/zero-byte placeholder.
    if (!tables.some((table) => table.name === "runtime_events")) throw new Error(`旧库 ${file} 不包含运行事件表，不能忽略或猜测来源`);
    const rows = source.prepare("SELECT sequence, event_id, schema_version, session_id, payload FROM runtime_events ORDER BY sequence").all();
    const payloads = rows.map((row) => JSON.parse(String(row.payload)) as StoredEvent);
    return { file, payloads, events: rows.map((row, index) => ({ ...payloads[index]!, eventId: row.event_id,
      sequence: row.sequence, schemaVersion: row.schema_version, sessionId: row.session_id })) };
  } finally { source.close(); }
}

/** A single verified history may have several retained representations. Never silently merge divergent writers. */
export async function readLegacySource(dataDir: string): Promise<{ events: StoredEvent[]; sources: LegacySource[] }> {
  const candidates: Candidate[] = [];
  for (const file of ["events.sqlite", "runtime.sqlite"]) if (await exists(join(dataDir, file))) candidates.push(await sqliteCandidate(dataDir, file));
  const jsonFile = "events.jsonl";
  if (await exists(join(dataDir, jsonFile))) {
    const text = await readFile(join(dataDir, jsonFile), "utf8");
    if (text && !text.endsWith("\n")) throw new Error("旧日志末行不完整，不能切换事实源");
    const payloads = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as StoredEvent);
    candidates.push({ file: jsonFile, payloads, events: payloads.map((event, index) => ({ ...event, eventId: eventIdentity(event, index), sequence: index + 1 })) });
  }
  // SQLite import can allocate different identities from JSONL. Prefer it only after checking every original JSONL payload.
  const databases = candidates.filter((candidate) => candidate.file !== jsonFile && candidate.events.length);
  const primary = [...(databases.length ? databases : candidates)].sort((a, b) => b.events.length - a.events.length)[0];
  const events = primary?.events ?? [];
  const sources = candidates.map((candidate): LegacySource => {
    const sqlite = candidate.file !== jsonFile;
    const included = candidate.events.length <= events.length && candidate.events.every((event, index) => digest(sqlite ? event : candidate.payloads[index]) ===
      digest(sqlite ? events[index] : primary?.payloads[index]));
    if (!included) throw new Error(`旧事实源 ${candidate.file} 与 ${primary?.file} 含不同历史，不能自动选择；请核对来源`);
    return { file: candidate.file, count: candidate.events.length, digest: digest(candidate.events),
      disposition: !candidate.events.length ? "empty" : candidate === primary ? "primary" : candidate.events.length === events.length ? "duplicate" : "prefix" };
  });
  return { events, sources };
}
