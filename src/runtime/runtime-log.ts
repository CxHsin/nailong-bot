import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeLog, StoredEvent } from "./runtime-types.js";
import { createToolArchive } from "./tool-archive.js";

export function createRuntimeLog(dataDir: string): RuntimeLog {
  const eventFile = join(dataDir, "events.jsonl");
  return {
    ...createToolArchive(dataDir),
    async bytes(): Promise<number> {
      try { return (await stat(eventFile)).size; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
    },
    async read(): Promise<StoredEvent[]> {
      let content: string;
      try { content = await readFile(eventFile, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as StoredEvent);
    },
    async append(event: Omit<StoredEvent, "at">): Promise<void> {
      await mkdir(dataDir, { recursive: true });
      const file = await open(eventFile, "a");
      try {
        await file.writeFile(`${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, "utf8");
        await file.sync();
      } finally { await file.close(); }
    },
  };
}
