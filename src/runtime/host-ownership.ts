import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** An OS-backed SQLite write lock is released on process death, without PID/TTL guesses. */
export async function acquireHostOwnership(dataDir: string) {
  await mkdir(dataDir, { recursive: true });
  const directory = await realpath(dataDir);
  const db = new DatabaseSync(join(directory, "host-owner.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5 || /locked|busy/i.test(String(error)))
      throw new Error("该数据目录已被另一个 Host 占用，请停止该 Host 或使用其他数据目录。");
    throw error;
  }
  let released = false;
  return { release() { if (!released) { released = true; db.close(); } } };
}
