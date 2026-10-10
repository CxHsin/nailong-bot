import type { TextContent } from "@mariozechner/pi-ai";
import type { PublicTextPhase } from "../runtime/progress.js";

/** Responses signatures carry public message identity/phase, never hidden reasoning. */
export function textPhase(part: TextContent) {
  if (!part.textSignature) return undefined;
  try {
    const signature = JSON.parse(part.textSignature) as { v?: unknown; phase?: unknown };
    return signature.v === 1 && (signature.phase === "commentary" || signature.phase === "final_answer") ? signature.phase : undefined;
  } catch { return undefined; }
}

/** Normalize public text only; no provider name or hidden reasoning determines its phase. */
export function publicTextPhase(part: TextContent, boundary?: { hasTools: boolean }): PublicTextPhase {
  const native = textPhase(part);
  // A step dispatching tools cannot settle as a final answer, even with a conflicting tag.
  if (boundary?.hasTools && native !== "commentary") return { phase: "commentary", phaseSource: "tool-boundary" };
  if (native) return { phase: native, phaseSource: "native" };
  if (!boundary) return { phase: "unresolved", phaseSource: "pending" };
  return { phase: "final_answer", phaseSource: "terminal-boundary" };
}
