export type PublicTextPhase =
  | { phase: "commentary"; phaseSource: "native" | "tool-boundary" }
  | { phase: "final_answer"; phaseSource: "native" | "terminal-boundary" }
  | { phase: "unresolved"; phaseSource: "pending" };

/** Live presentation only. Model/tool facts are already recorded by their owners. */
export type RunProgress =
  | ({ type: "text"; segmentId: string; kind: "status" | "progress" | "result" | "final"; text: string; finalized: boolean; formal?: boolean; source?: "execution" | "progress-model"; actionState?: "started" | "completed" | "failed" } & Partial<PublicTextPhase>)
  | { type: "discard"; segmentId: string }
  | { type: "tool"; name: string; callId?: string; state: "started" | "completed" | "failed" | "blocked" };
