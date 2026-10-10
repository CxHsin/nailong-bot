import type { Update } from "./app-types.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import type { CommandInput } from "./command-input.js";
import { handlePromptCommand } from "./commands.js";
import { handleMemoryCommand, forgetMemory, type MemoryCommandOptions } from "./memory-commands.js";

function legacyCommandInput(update: Update): CommandInput {
  return { ownerId: update.userId, messageId: update.messageId, replyToMessageId: update.replyToMessageId,
    hasAttachments: !!update.images?.length };
}

/** Only the retained legacy application's adapter owns its Telegram Update and old reset semantics. */
export async function handleLegacyCommand(log: RuntimeLog, options: { promptFile?: string; send: (text: string, update: Update) => Promise<void> }, update: Update, text: string, onStarted?: () => void): Promise<boolean> {
  const response = await handlePromptCommand(log, options, legacyCommandInput(update), text, onStarted);
  if (response !== undefined) { await options.send(response, update); return true; }
  if (!update.images?.length && text === "/reset") {
    const batch = [{ type: "message", role: "user", text, chatId: update.userId, messageId: update.messageId }, { type: "reset" }];
    if (log.appendBatch) await log.appendBatch(batch);
    else for (const event of batch) await log.append(event);
    onStarted?.();
    await options.send("已开始新对话，旧记录仍保留在本地。", update);
    return true;
  }
  return false;
}

/** Natural forgetting is an old adapter feature; production recognizes slash commands only. */
export async function handleLegacyMemoryCommand(log: RuntimeLog, options: MemoryCommandOptions & { send: (text: string, update: Update) => Promise<void> }, update: Update, text: string, onStarted?: () => void): Promise<boolean> {
  const input = legacyCommandInput(update);
  let response = await handleMemoryCommand(log, options, input, text, onStarted);
  const natural = /^(?:请)?(?:帮我)?(?:忘掉|忘记|不要再记得)/.test(text) && !/[?？]|怎么办|如何|怎么|为什么|是否|能否|吗/.test(text);
  if (response === undefined && !input.hasAttachments && natural) {
    const targetText = text.replace(/^(?:请)?(?:帮我)?(?:忘掉|忘记|不要再记得)\s*/, "").trim();
    const replyIntent = /^(?:请)?(?:帮我)?(?:忘掉|忘记|不要再记得)(?:这件事|这条消息|这个轮次|这一轮|这个)[。！!]?$/u.test(text);
    response = await forgetMemory(log, options, input, text, { targetText, replyIntent }, onStarted);
  }
  if (response === undefined) return false;
  await options.send(response, update);
  return true;
}
