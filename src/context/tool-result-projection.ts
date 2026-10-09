import { archivePlaceholder, shouldPrune } from "../runtime/tool-archive.js";
import type { ToolArchive, ToolResult } from "../runtime/runtime-types.js";
import { webResultPreview } from "../runtime/web-result.js";
import { toolProvenance } from "../runtime/tool-provenance.js";

// A durable decision records what the active model step saw. Replay honors it.
export const TOOL_RESULT_PROJECTION_VERSION = 2;
export function toolResultView(toolName: string, result: ToolResult, archive: ToolArchive | undefined, archiveRead: boolean) {
  const source = toolProvenance(toolName, result);
  if (source.source === "tinyfish") toolName = source.name;
  const skillPage = toolName === "read" && typeof (result.details as { skill?: unknown } | undefined)?.skill === "string";
  const modelVisible = toolName !== "tool_search" && !skillPage && archive && shouldPrune(result, archiveRead) ? "archive" : "original";
  return { modelVisible, content: modelVisible === "archive" ?
    (toolName === "web_fetch" ? webResultPreview(result, archive!) : undefined) ?? archivePlaceholder(toolName, archive!) : result.content } as const;
}

export function replayToolResultView(options: { result: ToolResult; archive?: ToolArchive;
  recorded?: unknown; projectionVersion?: unknown; archiveRead: boolean; olderThanRecent: boolean; toolName: string; sourceFiltered?: boolean }) {
  const { result, archive, recorded, archiveRead, olderThanRecent } = options;
  const source = toolProvenance(options.toolName, result);
  const toolName = source.source === "tinyfish" ? source.name : options.toolName;
  const pruned = !options.sourceFiltered && (recorded === "archive" || (recorded === undefined &&
    (shouldPrune(result, archiveRead) || (olderThanRecent && shouldPrune(result, false)))));
  return { content: pruned && archive ?
    (toolName === "web_fetch" && options.projectionVersion === 2 ? webResultPreview(result, archive) : undefined) ?? archivePlaceholder(toolName, archive) : result.content,
    details: pruned ? {} : result.details };
}
