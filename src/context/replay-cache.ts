import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { RuntimeLog, StoredEvent, ToolResult } from "../runtime/runtime-types.js";
import { sourceDigest } from "../runtime/event-digest.js";
import { filterMemoryEvents } from "../runtime/memory-exclusion.js";
import { replayEvents, type Replay } from "./projection.js";

type Snapshot = { version: 1; key: string; raw: StoredEvent[]; replay: Replay; results: Record<string, ToolResult> };
export function createReplayCache(dataDir: string, identity: string) {
  const key = sourceDigest({ version: 1, policy: "provider-replay-v2", identity });
  const path = join(dataDir, "context-projections", `${key}.json`);
  let cached: Snapshot | undefined;
  let loaded = false;
  return {
    async replay(log: RuntimeLog, currentId: string, model: Model<Api>, structured: boolean, progress?: (checked: number, total: number) => void, signal?: AbortSignal): Promise<Replay> {
      if (!loaded) {
        loaded = true;
        try {
          const envelope = JSON.parse(await readFile(path, "utf8"));
          if (envelope.snapshot?.version === 1 && envelope.snapshot.key === key && sourceDigest(envelope.snapshot) === envelope.sha256) cached = envelope.snapshot;
        } catch { /* Derived state is disposable; raw history remains authoritative. */ }
      }
      const raw = await log.read();
      const results: Record<string, ToolResult> = { ...(cached?.results ?? {}) };
      let start = 0;
      if (cached && raw.length >= cached.raw.length && sourceDigest(raw.slice(0, cached.raw.length)) === sourceDigest(cached.raw)) {
        const delta = raw.slice(cached.raw.length);
        const invalidates = delta.some((event) => ["conversation_reset", "reset", "memory_excluded", "bot_prompt_config"].includes(event.type));
        const host = raw.some((event) => event.requestId === currentId && typeof event.conversationId === "string");
        const all = filterMemoryEvents(raw);
        const reset = all.findLastIndex((event) => ["reset", "conversation_reset"].includes(event.type));
        const events = all.slice(reset + 1);
        // Legacy recency changes affect historical tool visibility: retain its full replay policy.
        if (!invalidates && host && cached.replay.events.length <= events.length) {
          start = cached.replay.events.length;
          const affected = new Set<string>([currentId]);
          for (const event of delta) {
            const id = event.requestId ?? event.runId;
            if (typeof id === "string") affected.add(id);
            if (event.type === "text_discarded") {
              const original = events.find((item) => item.textSegmentId === event.textSegmentId && item.requestId);
              if (original?.requestId) affected.add(original.requestId);
            }
          }
          for (let i = 0; i < start; i++) if (affected.has(String(events[i]!.requestId ?? events[i]!.runId))) { start = i; break; }
          // Never cut a tool step whose result crosses the proposed boundary.
          let crossing = cached.replay.units.find((unit) => unit.through > start && unit.requestId && !affected.has(unit.requestId));
          while (crossing) {
            const index = events.findIndex((event) => event.requestId === crossing!.requestId);
            start = Math.min(start, Math.max(0, index));
            crossing = cached.replay.units.find((unit) => unit.through > start && unit.requestId && !affected.has(unit.requestId) && events.findIndex((event) => event.requestId === unit.requestId) < start);
          }
        }
      }
      const replay = await replayEvents({ ...log, read: async () => raw, recoverArchive: async (archive, source) => {
        const archiveKey = sourceDigest(archive);
        if (results[archiveKey]) return structuredClone(results[archiveKey]);
        const result = await log.recoverArchive(archive, source);
        results[archiveKey] = structuredClone(result);
        return result;
      } }, currentId, model, structured, progress, signal,
        start && cached ? { replay: cached.replay, start } : undefined);
      if (signal?.aborted) throw new DOMException("历史恢复已取消", "AbortError");
      cached = { version: 1, key, raw, replay: structuredClone(replay), results };
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(join(dataDir, "context-projections"), { recursive: true });
        await writeFile(temporary, JSON.stringify({ snapshot: cached, sha256: sourceDigest(cached) }), "utf8");
        await rename(temporary, path);
      } catch { /* Cache persistence failure cannot block the answer. */ }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
      return replay;
    },
  };
}
