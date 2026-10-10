import type { TextContent } from "@mariozechner/pi-ai";

/** Responses signatures carry public message identity/phase, never hidden reasoning. */
export function textPhase(part: TextContent) {
  if (!part.textSignature) return undefined;
  try {
    const signature = JSON.parse(part.textSignature) as { v?: unknown; phase?: unknown };
    return signature.v === 1 && (signature.phase === "commentary" || signature.phase === "final_answer") ? signature.phase : undefined;
  } catch { return undefined; }
}
