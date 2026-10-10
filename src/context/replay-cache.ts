import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { RuntimeLog, StoredEvent, ToolResult } from "../runtime/runtime-types.js";
import { sourceDigest } from "../runtime/event-digest.js";
import { filterMemoryEvents } from "../runtime/memory-exclusion.js";
import { replayEvents, type Replay } from "./projection.js";
import { activeContextStart } from "./active-context.js";
import { eventIdentity } from "../runtime/memory-facts.js";

type Snapshot = { version: 1; key: string; identity?: string; prefixDigest?: string;
  raw: StoredEvent[]; replay: Replay; results: Record<string, ToolResult> };
export function createReplayCache(dataDir: string, identity: string) {
  const key = sourceDigest({ version: 1, policy: "continuous-active-context-input-controls-v2", identity });
  const path = join(dataDir, "context-projections", `${key}.json`);
  let cached: Snapshot | undefined;
  let loaded = false;
  return {
    async replay(log: RuntimeLog, currentId: string, model: Model<Api>, structured: boolean, progress?: (checked: number, total: number) => void, signal?: AbortSignal): Promise<Replay> {
      if (!loaded) {
        loaded = true;
        try {
          const envelope = JSON.parse(await readFile(path, "utf8"));
          if (envelope.snapshot?.version === 1 && envelope.snapshot.key === key && envelope.snapshot.identity === identity &&
            Array.isArray(envelope.snapshot.raw) && envelope.snapshot.prefixDigest === sourceDigest(envelope.snapshot.raw) &&
            Array.isArray(envelope.snapshot.replay?.units) && sourceDigest(envelope.snapshot) === envelope.sha256) cached = envelope.snapshot;
        } catch { /* Derived state is disposable; raw history remains authoritative. */ }
      }
      let raw = await log.read();
      let legacy: { requestIds: string[]; boundary: string } | undefined;
      if (!activeContextStart(raw)) {
        const oldKeys = ["recent-three-skills-v2", "recent-three-stable-tools-v3"].map((policy) => sourceDigest({ version: 1, policy, identity }));
        const candidates: Snapshot[] = [];
        for (const oldKey of oldKeys) {
          try {
            const envelope = JSON.parse(await readFile(join(dataDir, "context-projections", `${oldKey}.json`), "utf8"));
            const value = envelope.snapshot as Snapshot;
            if (value?.version === 1 && value.key === oldKey && sourceDigest(value) === envelope.sha256 &&
              Array.isArray(value.raw) && value.raw.length <= raw.length && sourceDigest(raw.slice(0, value.raw.length)) === sourceDigest(value.raw) &&
              Array.isArray(value.replay?.units) && typeof value.replay.boundary === "string" &&
              !raw.slice(value.raw.length).some((event) => ["reset", "conversation_reset", "memory_excluded", "bot_prompt_config"].includes(event.type))) candidates.push(value);
          } catch { /* An unavailable legacy projection uses the one-time original reconstruction. */ }
        }
        const previous = candidates.sort((a, b) => b.raw.length - a.raw.length)[0];
        if (previous) {
          const requestIds = previous.replay.units.flatMap((unit) => {
            const id = unit.requestId;
            if (!id) return [];
            const oldLegacy = /^legacy:(\d+)$/.exec(id);
            if (!oldLegacy) return [id];
            const source = previous.replay.events[Number(oldLegacy[1])];
            const index = source ? previous.raw.findIndex((event) => sourceDigest(event) === sourceDigest(source)) : -1;
            return index < 0 ? [] : [`legacy:${eventIdentity(previous.raw[index]!, index)}`];
          });
          legacy = { requestIds: [...new Set(requestIds)], boundary: previous.replay.boundary };
          cached = previous;
        }
      }
      const results: Record<string, ToolResult> = { ...(cached?.results ?? {}) };
      let start = 0;
      if (cached && raw.length >= cached.raw.length && sourceDigest(raw.slice(0, cached.raw.length)) === sourceDigest(cached.raw)) {
        const delta = raw.slice(cached.raw.length);
        const invalidates = delta.some((event) => ["conversation_reset", "reset", "memory_excluded", "bot_prompt_config"].includes(event.type));
        const host = raw.some((event) => event.requestId === currentId && typeof event.conversationId === "string");
        const all = filterMemoryEvents(raw);
        const reset = all.findLastIndex((event) => ["reset", "conversation_reset"].includes(event.type));
        const events = all.slice(reset + 1);
        // Conversation snapshots replay the earliest affected Run. The retained
        // legacy adapter still uses its original complete reconstruction.
        if (!invalidates && host && cached.replay.events.length <= events.length) {
          start = cached.replay.events.length;
          const affected = new Set<string>([currentId]);
          const previousCurrent = cached.replay.units.find((unit) => unit.messages.some((message) =>
            message.role === "user" && sourceDigest(message) === sourceDigest(cached!.replay.current)));
          // Eligibility changes across a Run boundary (for example current-only
          // feedback), even though recorded tool-result bytes stay identical.
          if (previousCurrent?.requestId && previousCurrent.requestId !== currentId) affected.add(previousCurrent.requestId);
          // Tool views remain stable when a Run becomes historical. The new
          // Run and genuinely appended facts alone determine the replay suffix.
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
      const replayLog = { ...log, read: async () => raw, append: async (event: Omit<StoredEvent, "at">) => {
        const result = await log.append(event); raw = await log.read(); return result;
      }, recoverArchive: async (archive: Parameters<RuntimeLog["recoverArchive"]>[0], source?: ToolResult) => {
        const archiveKey = sourceDigest(archive);
        if (results[archiveKey]) {
          if (source && sourceDigest(source) !== sourceDigest(results[archiveKey]))
            throw new Error("工具归档与事件结果不一致");
          return structuredClone(results[archiveKey]);
        }
        const result = await log.recoverArchive(archive, source);
        results[archiveKey] = structuredClone(result);
        return result;
      } };
      const replay = await replayEvents(replayLog, currentId, model, structured, progress, signal,
        start && cached && !legacy ? { replay: cached.replay, start } : undefined, legacy);
      if (signal?.aborted) throw new DOMException("历史恢复已取消", "AbortError");
      cached = { version: 1, key, identity, prefixDigest: sourceDigest(raw), raw, replay: structuredClone(replay), results };
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
