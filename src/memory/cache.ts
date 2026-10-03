import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const MEMORY_INDEX_FILE = "memory.sqlite";
export const MEMORY_INITIALIZATION_DIR = "memory-initialization";
export const EMBEDDING_CACHE_FILE = "embeddings.sqlite";
const CACHE_VERSION = 1;
const SCHEMAS = {
  memory: { file: MEMORY_INDEX_FILE,
    sql: "CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)" },
  embedding: { file: EMBEDDING_CACHE_FILE,
    sql: "CREATE TABLE vectors (key TEXT PRIMARY KEY, namespace TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE embedding_meta (namespace TEXT PRIMARY KEY, dimension INTEGER NOT NULL)" },
};

export function openMemoryCache(dataDir: string, kind: keyof typeof SCHEMAS) {
  mkdirSync(dataDir, { recursive: true });
  const schema = SCHEMAS[kind];
  const path = resolve(dataDir, schema.file);
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink > 1) throw new Error("派生记忆缓存必须是独立普通文件");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let db: DatabaseSync | undefined;
  let incompatible = false;
  try {
    db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=5000");
    const tables = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (!tables.length) {
      db.exec(`${schema.sql}; PRAGMA user_version=${CACHE_VERSION}`);
      return { db, recovered: false };
    }
    const version = db.prepare("PRAGMA user_version").get()!;
    const normalized = (sql: string) => sql.trim().replace(/\s+/g, " ").toLowerCase();
    const expected = schema.sql.split(";").map(normalized).sort();
    incompatible = version.user_version !== CACHE_VERSION ||
      JSON.stringify(tables.map((table) => normalized(String(table.sql))).sort()) !== JSON.stringify(expected) ||
      db.prepare("PRAGMA quick_check").all().some((row) => row.quick_check !== "ok");
    if (!incompatible) return { db, recovered: false };
  } catch (error) {
    const code = ((error as { errcode?: number }).errcode ?? 0) & 255;
    if (code !== 11 && code !== 26) { db?.close(); throw error; }
    incompatible = true;
  }
  db?.close();
  if (!incompatible) throw new Error("派生记忆缓存校验失败");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  const rebuilt = new DatabaseSync(path);
  try { rebuilt.exec(`PRAGMA busy_timeout=5000; ${schema.sql}; PRAGMA user_version=${CACHE_VERSION}`); }
  catch (error) { rebuilt.close(); throw error; }
  return { db: rebuilt, recovered: true };
}
export async function invalidateMemoryIndex(dataDir: string) {
  await Promise.all([rm(resolve(dataDir, MEMORY_INDEX_FILE), { force: true }),
    rm(resolve(dataDir, MEMORY_INITIALIZATION_DIR, MEMORY_INDEX_FILE), { force: true })]);
}
