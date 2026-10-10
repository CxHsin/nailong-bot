import type { ImageContent } from "@mariozechner/pi-ai";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import type { RunProgress } from "../runtime/progress.js";

export type Update = { userId: number; chatType: string; text?: string; images?: ImageContent[]; messageId: number; replyToMessageId?: number };
export type Message = { role: "user" | "assistant"; text: string; images?: ImageContent[] };
export type Request = { modelAlias?: string; contextBudgetBoost?: boolean; id: string; log: RuntimeLog; conversationId?: string; botPrompt?: string; botPromptVersion?: string;
  channel?: string;
  skillSnapshot?: import("../agent/skills.js").SkillSnapshot;
  inputId?: string;
  loadedSkillPaths?: string[];
  onProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
  bindSteering?: import("../host/host.js").RunExecutionContext["bindSteering"];
  onModelInput?: () => Promise<void>;
  /** Compatibility callback for the old log-backed Telegram application. */
  onText?: (textSegmentId: string) => Promise<void> };
export class DeliveryRejected extends Error {
  constructor(message: string, readonly retryAfterMs?: number) { super(message); }
}
