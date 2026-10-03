import { archiveReadPath, archiveSourceEvent, readableResult } from "../runtime/tool-archive.js";
import { eventIdentity, memoryExclusions } from "../runtime/memory-facts.js";
import { filterArchivedMemoryResult, filterMemoryToolResult } from "../runtime/memory-exclusion.js";
import { createReadToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { RuntimeLog, ToolArchive, ToolResult } from "../runtime/runtime-types.js";

const MAX_RESPONSE_BYTES = 7500;

export function createBoundedRead(dataDir: string, log: RuntimeLog) {
  const ordinary = createReadToolDefinition(dataDir);
  return { ...ordinary,
    async execute(id: string, args: { path: string; offset?: number; limit?: number },
      signal: Parameters<typeof ordinary.execute>[2], update: Parameters<typeof ordinary.execute>[3],
      context: Parameters<typeof ordinary.execute>[4]) {
      if (!log.isArchiveRead("read", args)) return ordinary.execute(id, args, signal, update, context);
      const path = archiveReadPath(dataDir, args)!;
      const fragment = args.path.split("#", 2)[1];
      const events = await log.read();
      const event = archiveSourceEvent(events, args);
      if (!event) throw new Error("工具归档没有对应的运行事件");
      const archive = event.archive as ToolArchive;
      const details = { archiveSourceId: eventIdentity(event, events.indexOf(event)) };
      const source = event.result as ToolResult | undefined;
      const result = await log.recoverArchive(archive, source);
      const serialized = JSON.stringify(result);
      if (source && serialized !== JSON.stringify(source)) throw new Error("工具归档与事件结果不一致");
      const excluded = memoryExclusions(events);
      const filtered = filterArchivedMemoryResult(events, event, filterMemoryToolResult(String(event.toolName), result, excluded), excluded);
      if (JSON.stringify(filtered.content) !== JSON.stringify(result.content)) return {
        content: [{ type: "text", text: "该归档包含已排除的记忆来源，默认读取不再展示；原始日志仍可通过 /memory log 明确诊断查阅。" }], details,
      };
      const lines = readableResult(result).split("\n");
      const offset = args.offset ?? 1;
      const limit = args.limit ?? 120;
      if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1) {
        throw new Error("归档 offset/limit 必须为正整数");
      }
      if (offset > lines.length) throw new Error(`Offset ${offset} is beyond end of archive (${lines.length} lines)`);
      const cursor = fragment?.match(/^sha256=([0-9a-f]{64})&byte=(\d+)$/);
      if (fragment && (!cursor || cursor[1] !== archive.sha256)) throw new Error("归档续读位置已失效");
      const startLine = lines.slice(0, offset - 1).reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
      const endLine = Math.min(lines.length, offset + Math.min(limit, 120) - 1);
      const end = lines.slice(0, endLine).reduce((n, line, i) => n + Buffer.byteLength(line) + (i < endLine - 1 ? 1 : 0), 0);
      const body = Buffer.from(lines.join("\n"));
      let start = cursor ? Number(cursor[2]) : startLine;
      if (!Number.isSafeInteger(start) || start < startLine || start > end ||
        (start > 0 && (body[start]! & 0xc0) === 0x80)) throw new Error("归档续读位置无效");
      let stop = Math.min(end, start + 5000);
      while (stop < end && (body[stop]! & 0xc0) === 0x80) stop--;
      const make = (until: number) => {
        const next = until < end ? `${path}#sha256=${archive.sha256}&byte=${until}` : undefined;
        const nextOffset = until === end && end < body.length ? endLine + 1 : undefined;
        const text = body.subarray(start, until).toString("utf8") + (nextOffset ? "\n" : "") +
          (next ? `\n[继续读取：read({"path":${JSON.stringify(next)},"offset":${offset},"limit":${limit}})]` :
            nextOffset ? `\n[继续读取：read({"path":${JSON.stringify(path)},"offset":${nextOffset},"limit":${limit}})]` : "");
        return { content: [{ type: "text" as const, text }], details };
      };
      while (stop > start && Buffer.byteLength(JSON.stringify(make(stop))) > MAX_RESPONSE_BYTES) {
        stop--;
        while (stop > start && (body[stop]! & 0xc0) === 0x80) stop--;
      }
      if (stop <= start) throw new Error("归档读取响应元数据超过字节预算");
      return make(stop);
    },
  } as ToolDefinition;
}
