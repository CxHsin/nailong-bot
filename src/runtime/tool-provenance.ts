/** The compatibility call envelope preserves policies owned by the original tool source. */
export function toolProvenance(toolName: string, result: { details?: unknown }) {
  const details = result.details as { source?: unknown; sourceToolName?: unknown } | undefined;
  if (!details || typeof details.source !== "string" || typeof details.sourceToolName !== "string")
    return { name: toolName, source: undefined };
  return { name: details.sourceToolName, source: details.source };
}
