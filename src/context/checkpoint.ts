import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import type { RuntimeLog, StoredEvent } from "../runtime/runtime-types.js";
import { sourceDigest } from "../runtime/event-digest.js";

export type Checkpoint = { version: 2; id: string; boundary: string; through: number; sourceDigest: string;
  lastEventDigest: string; summaryStrategy: "full-result-v1" | "structured-text-v1";
  summary: string; previousId?: string; model: string; ratio: number; createdAt: string };

export function createCheckpointStore(dataDir: string, strategy: Checkpoint["summaryStrategy"] = "full-result-v1", conversationId?: string, log?: RuntimeLog) {
  const root = conversationId ? join(dataDir, "checkpoints", "conversations") : dataDir;
  const dir = conversationId ? join(root, createHash("sha256").update(conversationId).digest("hex")) : join(root, "checkpoints");
  return {
    async invalidate() {
      if (dirname(resolve(dir)) !== resolve(root)) throw new Error("历史摘要缓存路径无效");
      await rm(dir, { recursive: true, force: true });
    },
    async load(boundary: string, events: StoredEvent[]): Promise<Checkpoint | undefined> {
      const migration = events.find((event) => event.type === "active_context_started" &&
        event.migration === "legacy-snapshot" && typeof event.legacyBoundary === "string");
      const validCheckpoint = (c: Checkpoint, expectedBoundary = boundary) => c?.version === 2 && typeof c.id === "string" &&
        typeof c.createdAt === "string" && c.summaryStrategy === strategy &&
        c.boundary === expectedBoundary && Number.isInteger(c.through) && c.through >= 1 && c.through <= events.length &&
        typeof c.summary === "string" && c.sourceDigest === sourceDigest(events.slice(0, c.through)) &&
        c.lastEventDigest === sourceDigest(events[c.through - 1]) &&
        !events.slice(c.through).some((event) => {
          const covered = events.slice(0, c.through);
          if (event.type === "text_discarded") return covered.some((source) => source.textSegmentId === event.textSegmentId);
          if (!["tool_result", "text_finalized", "answer_generated", "run_succeeded", "delivery_succeeded"].includes(event.type)) return false;
          const owner = event.requestId ?? event.runId;
          // Host settlement already makes the final answer eligible for replay.
          // A subsequent channel receipt changes delivery state, not the text
          // summarized here. Legacy requests still acquire eligibility on delivery.
          if (event.type === "delivery_succeeded" && covered.some((source) => source.type === "run_succeeded" &&
            (source.requestId ?? source.runId) === owner && (source.result as { kind?: string } | undefined)?.kind === "model")) return false;
          return covered.some((source) => ["request_completed", "request_failed", "request_interrupted", "run_succeeded", "run_failed", "run_cancelled"].includes(source.type) &&
            (source.requestId ?? source.runId) === owner) ||
            event.type === "tool_result" && covered.some((source) => source.type === "tool_result" && source.requestId === owner && source.toolCallId === event.toolCallId);
        });
      const durable = log ? (await log.read()).filter((event) => event.type === "context_checkpoint_committed") : [];
      const committed = durable.flatMap((event) => {
        const c = event.checkpoint as Checkpoint;
        return sourceDigest(c) === event.sha256 && validCheckpoint(c) ? [c] : [];
      });
      if (committed.length) return committed.sort((a, b) => b.through - a.through || b.createdAt.localeCompare(a.createdAt))[0];
      let names: string[];
      try { names = await readdir(dir); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
      const valid: Checkpoint[] = [];
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        try {
          const envelope = JSON.parse(await readFile(join(dir, name), "utf8"));
          const c = envelope.checkpoint as Checkpoint;
          const legacy = migration && validCheckpoint(c, String(migration.legacyBoundary)) &&
            c.through <= Number(migration.sourceThrough) && boundary === `active-v1:${String(migration.activeContextId)}`;
          if ((!validCheckpoint(c) && !legacy) || sourceDigest(c) !== envelope.sha256 ||
            log && !legacy && !durable.some((event) => (event.checkpoint as Checkpoint)?.id === c.id && event.sha256 === envelope.sha256)) continue;
          if (legacy && log) {
            // Adopt the already validated replacement without another model call.
            const { version: _version, id: _id, createdAt: _createdAt, ...value } = c;
            return this.save({ ...value, boundary, previousId: c.id });
          }
          valid.push(c);
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
        }
      }
      return valid.sort((a, b) => b.through - a.through || b.createdAt.localeCompare(a.createdAt))[0];
    },
    async save(value: Omit<Checkpoint, "version" | "id" | "createdAt">, signal?: AbortSignal): Promise<Checkpoint> {
      const checkpoint: Checkpoint = { ...value, version: 2, id: randomUUID(), createdAt: new Date().toISOString() };
      const serialized = JSON.stringify({ checkpoint, sha256: sourceDigest(checkpoint) });
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${checkpoint.id}.json`);
      const temp = `${path}.tmp`;
      try {
        signal?.throwIfAborted();
        const file = await open(temp, "wx");
        try { await file.writeFile(serialized, "utf8"); await file.sync(); }
        finally { await file.close(); }
        if (createHash("sha256").update(await readFile(temp)).digest("hex") !==
          createHash("sha256").update(serialized).digest("hex")) throw new Error("历史 checkpoint 写入校验失败");
        await rename(temp, path);
        try {
          // This is the acceptance boundary. Cancellation observed before the
          // authoritative append leaves the old replacement intact; a committed
          // fact is never rolled back by a later cancellation.
          signal?.throwIfAborted();
          if (log) await log.append({ type: "context_checkpoint_committed", checkpoint, sha256: sourceDigest(checkpoint), contextPolicy: "exclude" });
        } catch (error) { await rm(path, { force: true }).catch(() => undefined); throw error; }
        return checkpoint;
      } finally { await rm(temp, { force: true }); }
    },
  };
}
