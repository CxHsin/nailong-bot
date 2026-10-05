import { mkdir, readdir, copyFile, readFile, writeFile, stat } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readLegacySource } from "../runtime/legacy-source.js";
import { validateMigrationAssociations } from "../runtime/migration-validation.js";
import { createToolArchive } from "../runtime/tool-archive.js";
import { createRuntimeEventLog } from "../runtime/event-log.js";
import type { ToolArchive } from "../runtime/runtime-types.js";

/** Offline maintenance: no Provider, Channel or startup recovery. Stop all writers first. */
async function migrate() {
  const dataDir = resolve(process.env.AGENT_DATA_DIR?.trim() || "data");
  const snapshot = await readLegacySource(dataDir);
  const associations = validateMigrationAssociations(snapshot.events);
  const archive = createToolArchive(dataDir);
  for (const event of snapshot.events) if (event.archive) await archive.loadArchive(event.archive as ToolArchive);
  const backupDir = join(dataDir, "backups", `runtime-handover-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(backupDir, { recursive: true });
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function copyTree(from: string, to: string, relative = "") {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (!relative && entry.name === "backups") continue;
      const source = join(from, entry.name); const target = join(to, entry.name); const path = join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error("数据备份包含符号链接，请核对实际数据位置");
      if (entry.isDirectory()) { await copyTree(source, target, path); continue; }
      if (/\.sqlite-(wal|shm)$/.test(entry.name)) continue;
      if (entry.name.endsWith(".sqlite") && (await stat(source)).size) {
        const db = new DatabaseSync(source, { readOnly: true });
        try { await backup(db, target); } finally { db.close(); }
      } else await copyFile(source, target);
      const body = await readFile(target);
      files.push({ path, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    }
  }
  await copyTree(dataDir, backupDir);
  await writeFile(join(backupDir, "backup-manifest.json"), JSON.stringify({ dataDir, sources: snapshot.sources, files }, null, 2));
  if (JSON.stringify(await readLegacySource(dataDir)) !== JSON.stringify(snapshot)) throw new Error("备份期间旧 writer 仍在变化，请停止后重试");
  const log = await createRuntimeEventLog(dataDir);
  const migrated = await log.read();
  if (migrated.length < snapshot.events.length || snapshot.events.some((event, index) => migrated[index]?.eventId !== event.eventId || migrated[index]?.sequence !== event.sequence))
    throw new Error("迁移后事件身份或顺序校验失败");
  const report = await log.migrationReport();
  await writeFile(join(backupDir, "migration-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ destination: join(dataDir, "runtime-v2.sqlite"), migratedEvents: snapshot.events.length,
    currentEvents: migrated.length, sources: report.sources, checkedReferences: associations.checkedReferences,
    historicalExceptions: report.exceptions.length, backupDir, modelsInvoked: 0, messagesSent: 0 }));
}

migrate().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
