import type { HostInput } from "../host/host.js";
import { conversationUserId } from "../runtime/conversation-log.js";

/** Existing persistent ownership and source references, independent of a Channel SDK update. */
export type CommandInput = {
  ownerId: number;
  conversationId?: string;
  messageId: number;
  replyToMessageId?: number;
  hasAttachments: boolean;
};

export function commandInput(input: HostInput): CommandInput {
  return {
    ownerId: conversationUserId(input.conversationId), conversationId: input.conversationId,
    // Retain the established zero receipt for Channels without source message IDs.
    messageId: Number(input.metadata?.messageId ?? 0),
    ...(typeof input.metadata?.replyToMessageId === "number" ? { replyToMessageId: input.metadata.replyToMessageId } : {}),
    hasAttachments: input.parts.some((part) => part.type !== "text"),
  };
}
