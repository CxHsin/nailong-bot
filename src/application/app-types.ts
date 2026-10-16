import type { ImageContent } from "@mariozechner/pi-ai";

export type ReplyMessage = { role: "user" | "assistant"; text?: string; hasImages: boolean };
export type Update = { userId: number; chatType: string; text?: string; images?: ImageContent[]; messageId: number; replyToMessageId?: number; replyToMessage?: ReplyMessage };
