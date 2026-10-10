import { archivePlaceholder, shouldPrune } from "../runtime/tool-archive.js";
import type { ToolArchive, ToolResult, RecordedToolProjection } from "../runtime/runtime-types.js";
import { webResultPreview } from "../runtime/web-result.js";
import { toolProvenance } from "../runtime/tool-provenance.js";
import { sourceDigest } from "../runtime/event-digest.js";

// A durable decision records what the active model step saw. Replay honors it.
export const TOOL_RESULT_PROJECTION_VERSION = 3;
export type { RecordedToolProjection } from "../runtime/runtime-types.js";
export function toolResultView(toolName: string, result: ToolResult, archive: ToolArchive | undefined, archiveRead: boolean) {
  const source = toolProvenance(toolName, result);
  if (source.source === "tinyfish") toolName = source.name;
  const skillPage = toolName === "read" && typeof (result.details as { skill?: unknown } | undefined)?.skill === "string";
  const modelVisible = toolName !== "tool_search" && !skillPage && archive && shouldPrune(result, archiveRead) ? "archive" : "original";
  const content = modelVisible === "archive" ?
    (toolName === "web_fetch" ? webResultPreview(result, archive!) : undefined) ?? archivePlaceholder(toolName, archive!) : result.content;
  const details = modelVisible === "archive" ? {} : result.details;
  const projection = { content, details, sourceDigest: sourceDigest({ result, archive }) };
  return { modelVisible, content, details, modelProjection: { ...projection, digest: sourceDigest(projection) } } as const;
}

export function replayToolResultView(options: { result: ToolResult; archive?: ToolArchive;
  recorded?: unknown; projectionVersion?: unknown; modelProjection?: unknown; sourceResult?: ToolResult;
  archiveRead: boolean; olderThanRecent: boolean; toolName: string; sourceFiltered?: boolean }) {
  const { result, archive, recorded, archiveRead, olderThanRecent } = options;
  if (options.projectionVersion !== undefined && ![1, 2, 3].includes(options.projectionVersion as number))
    throw new Error("工具模型视图版本不受支持");
  if (recorded !== undefined && recorded !== "original" && recorded !== "archive")
    throw new Error("工具模型视图记录无效");
  if (recorded === "archive" && !archive) throw new Error("工具模型视图缺少归档来源");
  if (options.projectionVersion === 3) {
    const projection = options.modelProjection as RecordedToolProjection | undefined;
    if (!projection || !Array.isArray(projection.content) ||
      projection.sourceDigest !== sourceDigest({ result: options.sourceResult ?? result, archive }) ||
      projection.digest !== sourceDigest({ content: projection.content, details: projection.details, sourceDigest: projection.sourceDigest })) {
      throw new Error("工具模型视图缺失或来源校验失败");
    }
    // Forgetting can legitimately change source visibility; the old view cannot
    // reintroduce an excluded original merely to keep the input prefix stable.
    return options.sourceFiltered ? { content: result.content, details: result.details } :
      { content: structuredClone(projection.content), details: structuredClone(projection.details) };
  }
  const source = toolProvenance(options.toolName, result);
  const toolName = source.source === "tinyfish" ? source.name : options.toolName;
  const pruned = !options.sourceFiltered && (recorded === "archive" || (recorded === undefined &&
    (shouldPrune(result, archiveRead) || (olderThanRecent && shouldPrune(result, false)))));
  return { content: pruned && archive ?
    (toolName === "web_fetch" && options.projectionVersion === 2 ? webResultPreview(result, archive) : undefined) ?? archivePlaceholder(toolName, archive) : result.content,
    details: pruned ? {} : result.details };
}
