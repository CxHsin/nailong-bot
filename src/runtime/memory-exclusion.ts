import { eventIdentity, memoryExclusions } from "./memory-facts.js";
import { archiveSourceEvent } from "./tool-archive.js";
import type { StoredEvent, ToolResult } from "./runtime-types.js";
import { toolProvenance } from "./tool-provenance.js";

export function filterMemoryEvents(events: StoredEvent[]): StoredEvent[] {
  const excluded = memoryExclusions(events);
  if (!excluded.size) return events;
  let legacyExcluded = false;
  return events.flatMap((event, index) => {
    const identity = eventIdentity(event, index);
    if (event.type === "message" && event.role === "user") legacyExcluded = !event.requestId && excluded.has(identity);
    if (event.requestId && excluded.has(event.requestId) || event.type === "message" && !event.requestId && legacyExcluded) return [];
    return [{ ...event, eventId: identity }];
  });
}
export function filterMemoryToolResult(toolName: string, result: ToolResult, excluded: Set<string>): ToolResult {
  const source = toolProvenance(toolName, result);
  if (source.source === "memory") toolName = source.name;
  if (!excluded.size || !isMemorySourceTool(toolName)) return result;
  let hidden = false;
  const content = result.content.map((part) => {
    if (part.type !== "text") return part;
    try {
      const value = JSON.parse(part.text);
      const redact = (item: { nodeId?: string; paths?: string[][] }) => ({ ...item,
        ...(item.paths ? { paths: item.paths.filter((path) => path.every((identity) => !excluded.has(identity))) } : {}) });
      if (Array.isArray(value)) return { ...part, text: JSON.stringify(value.filter((item) => !excluded.has(item.nodeId)).map(redact)) };
      if (value && typeof value === "object" && typeof value.nodeId === "string" && !excluded.has(value.nodeId))
        return { ...part, text: JSON.stringify(redact(value)) };
    } catch { hidden = true; }
    hidden = true; return { ...part, text: "记忆来源已排除或无法验证，旧结果不再回放。" };
  });
  return { ...result, content, isError: result.isError || hidden };
}
export function isMemorySourceTool(toolName: string): boolean {
  return ["memory_search", "memory_read"].includes(toolName);
}

export function filterArchivedMemoryResult(events: StoredEvent[], event: StoredEvent, result: ToolResult, excluded: Set<string>): ToolResult {
  if (!excluded.size || event.toolName !== "read") return result;
  const visited = new Set<StoredEvent>();
  const affected = (source: StoredEvent): boolean => {
    if (visited.has(source)) return true;
    visited.add(source);
    const original = source.result as ToolResult | undefined;
    if (isMemorySourceTool(String(source.toolName)) || original && toolProvenance(String(source.toolName), original).source === "memory") return !original ||
      JSON.stringify(filterMemoryToolResult(String(source.toolName), original, excluded).content) !== JSON.stringify(original.content);
    if (source.toolName !== "read") return false;
    const sourceId = (original?.details as { archiveSourceId?: unknown } | undefined)?.archiveSourceId;
    if (typeof sourceId === "string") {
      const parent = events.find((entry, index) => eventIdentity(entry, index) === sourceId);
      return !parent || affected(parent);
    }
    const dispatch = events.findLast((entry) => entry.type === "tool_dispatch" && entry.requestId === source.requestId && entry.toolCallId === source.toolCallId);
    const parent = archiveSourceEvent(events, dispatch?.args);
    return !!parent && affected(parent);
  };
  return affected(event) ? { content: [{ type: "text", text: "归档包含已排除的记忆来源，旧读取结果不再回放；原始归档仍保留用于明确诊断。" }], details: {}, isError: true } : result;
}
