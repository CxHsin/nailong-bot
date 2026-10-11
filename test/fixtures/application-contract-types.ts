import type { TelegramChannelHost } from "../../src/application/channel-contract.js";
import type { AgentExecution } from "../../src/application/agent-contract.js";
import type { CommandInput } from "../../src/application/command-input.js";

// Compilation proves Channels depend only on the operations they consume.
export const channelHost: TelegramChannelHost = {
  submit: () => { throw new Error("compile fixture"); },
  notifyRecovery: async () => {},
  recordProgress: async () => {},
  deliverContent: async () => ({ complete: true, messageId: 1, outcome: "succeeded" }),
};
export const basicAgent: AgentExecution = { answer: async () => "answer" };
export const command: CommandInput = { ownerId: 42, conversationId: "telegram:private:42", messageId: 1, hasAttachments: false };
// @ts-expect-error A Channel SDK update is not a shared command input.
export const updateAsCommand: CommandInput = { userId: 42, chatType: "private", messageId: 1, text: "/prompt" };
