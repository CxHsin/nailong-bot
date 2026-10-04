import type { ImageContent } from "@mariozechner/pi-ai";
import type { RuntimeLog } from "../runtime/runtime-types.js";

export type Update = { userId: number; chatType: string; text?: string; images?: ImageContent[]; messageId: number; replyToMessageId?: number };
export type Message = { role: "user" | "assistant"; text: string; images?: ImageContent[] };
export type Request = { id: string; log: RuntimeLog; conversationId?: string; botPrompt?: string; botPromptVersion?: string; onText?: (textSegmentId: string) => Promise<void> };
export class DeliveryRejected extends Error {
  constructor(message: string, readonly retryAfterMs?: number) { super(message); }
}
