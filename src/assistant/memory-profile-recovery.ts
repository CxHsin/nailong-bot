import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

type ProfileRange = { conversationId: string; rangeId: string; sourceIds: string[]; expectedVersion: number };
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Read old execution facts without opening a Harness (which would resume live main work). */
export async function recoverProfileJobs(rootDirectory: string,
  source: (id: string) => { conversationId: string } | undefined,
  enqueue: (input: ProfileRange) => unknown) {
  for (const directory of await readdir(rootDirectory, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const path = join(rootDirectory, directory.name, "session.sqlite");
    try { if (!(await stat(path)).isFile()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const storage = await openNodeSqliteStorage(path);
    try {
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanTasks({ kind: "nailong.memory-refinement", status: "terminal" }, 100, cursor, context);
        for (const task of page.items) {
          if (task.state.status !== "terminal" || task.state.outcome.status !== "completed") continue;
          if (!["unavailable", "stale"].includes(String(record(task.state.outcome.result)?.status))) continue;
          const input = record(task.input);
          if (!input || typeof input.compactTask !== "number" || !Number.isSafeInteger(input.compactTask)
            || typeof input.rangeId !== "string" || typeof input.expectedVersion !== "number" || !Number.isSafeInteger(input.expectedVersion)
            || !Array.isArray(input.sourceIds) || !input.sourceIds.length || !input.sourceIds.every(id => typeof id === "string")) continue;
          const sourceIds = input.sourceIds as string[];
          // Compaction ranges also contain resident SELF and recalled historical sources.
          // The owning conversation is the source identity matching this execution directory.
          const conversationId = sourceIds.map(id => source(id)?.conversationId).find(id => id &&
            createHash("sha256").update(id).digest("hex") === directory.name);
          if (!conversationId) continue;
          const compacted = await storage.task(input.compactTask as TaskId, context);
          if (compacted?.kind !== "pi.compaction" || compacted.conversationId !== task.conversationId
            || compacted.state.status !== "terminal" || compacted.state.outcome.status !== "completed") continue;
          const result = record(compacted.state.outcome.result);
          if (typeof result?.entryId !== "number" && typeof result?.submissionId !== "number") continue;
          enqueue({ conversationId, rangeId: input.rangeId, sourceIds, expectedVersion: input.expectedVersion });
        }
        cursor = page.next;
      } while (cursor);
    } finally { await storage.close(context); }
  }
}
