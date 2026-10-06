/** Live presentation only. Model/tool facts are already recorded by their owners. */
export type RunProgress =
  | { type: "text"; segmentId: string; kind: "status" | "progress" | "result" | "final"; text: string; finalized: boolean; formal?: boolean; source?: "execution" | "progress-model"; actionState?: "started" | "completed" | "failed" }
  | { type: "discard"; segmentId: string }
  | { type: "tool"; name: string; callId?: string; state: "started" | "completed" | "failed" | "blocked" };
