/** Encoding for retained historical structured Provider messages; no live writer. */
export type StructuredText = { type: "status" | "result" | "final" | "progress"; text: string };
export function protocolText(type: StructuredText["type"], text: string): string {
  return JSON.stringify({ type, text });
}
