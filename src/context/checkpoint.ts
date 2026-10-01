import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StoredEvent } from "../runtime/runtime-types.js";
import { sourceDigest } from "../runtime/event-digest.js";

export type Checkpoint = { version: 2; id: string; boundary: string; through: number; sourceDigest: string;
  lastEventDigest: string; summaryStrategy: "full-result-v1" | "structured-text-v1";
  summary: string; previousId?: string; model: string; ratio: number; createdAt: string };

export function createCheckpointStore(dataDir: string, strategy: Checkpoint["summaryStrategy"] = "full-result-v1") {
  const dir = join(dataDir, "checkpoints");
  return {
    async load(boundary: string, events: StoredEvent[]): Promise<Checkpoint | undefined> {
      let names: string[];
      try { names = await readdir(dir); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
      const valid: Checkpoint[] = [];
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        try {
          const envelope = JSON.parse(await readFile(join(dir, name), "utf8"));
          const c = envelope.checkpoint as Checkpoint;
          if (c?.version !== 2 || c.summaryStrategy !== strategy ||
            c.boundary !== boundary || !Number.isInteger(c.through) ||
            c.through < 1 || c.through > events.length || typeof c.summary !== "string" ||
            sourceDigest(c) !== envelope.sha256 || c.sourceDigest !== sourceDigest(events.slice(0, c.through)) ||
            c.lastEventDigest !== sourceDigest(events[c.through - 1])) continue;
          valid.push(c);
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
        }
      }
      return valid.sort((a, b) => b.through - a.through || b.createdAt.localeCompare(a.createdAt))[0];
    },
    async save(value: Omit<Checkpoint, "version" | "id" | "createdAt">): Promise<Checkpoint> {
      const checkpoint: Checkpoint = { ...value, version: 2, id: randomUUID(), createdAt: new Date().toISOString() };
      const serialized = JSON.stringify({ checkpoint, sha256: sourceDigest(checkpoint) });
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${checkpoint.id}.json`);
      const temp = `${path}.tmp`;
      try {
        const file = await open(temp, "wx");
        try { await file.writeFile(serialized, "utf8"); await file.sync(); }
        finally { await file.close(); }
        if (createHash("sha256").update(await readFile(temp)).digest("hex") !==
          createHash("sha256").update(serialized).digest("hex")) throw new Error("历史 checkpoint 写入校验失败");
        await rename(temp, path);
        return checkpoint;
      } finally { await rm(temp, { force: true }); }
    },
  };
}
