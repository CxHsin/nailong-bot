import type { ImageContent } from "@mariozechner/pi-ai";
import type { TelegramMaterial } from "../assistant/persona.js";

export type ReplyMessage = { role: "user" | "assistant"; text?: string; hasImages: boolean };
export type Update = { userId: number; chatType: string; text?: string; images?: ImageContent[]; runtimeMaterials?: string[]; telegram?:TelegramMaterial; messageId: number; replyToMessageId?: number; replyToMessage?: ReplyMessage };
