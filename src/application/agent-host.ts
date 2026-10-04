import { createHost, type HostInput, type RunResult } from "../host/host.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { conversationLog, conversationUserId } from "../runtime/conversation-log.js";
import { handleCommand } from "./commands.js";
import { handleMemoryCommand } from "./memory-commands.js";
import { projectDeliveredChat } from "./runtime-projections.js";
import type { Message, Request, Update } from "./app-types.js";
import { cacheStatistics, cacheReportText } from "../runtime/cache-statistics.js";

export const AGENT_COMMANDS = [
  { command: "help", description: "查看命令帮助", usage: "/help" },
  { command: "kvcache", description: "查看最近四次运行与会话缓存统计", usage: "/kvcache" },
  { command: "reset", description: "开始新上下文，保留记录和累计统计", usage: "/reset" },
  { command: "prompt", description: "查看、设置或恢复 bot 提示词", usage: "/prompt；/prompt set 提示词；/prompt reset" },
  { command: "forget", description: "排除指定旧轮次的记忆和上下文", usage: "/forget 节点引用；回复目标消息发送 /forget" },
  { command: "memory", description: "诊断查阅原始轮次日志", usage: "/memory log 节点引用 [字符位置]" },
] as const;

type AgentHostOptions = { log: RuntimeLog; dataDir: string; promptFile: string; agent: {
  answer(messages: Message[], request: Request): Promise<string>; purgeEmbeddingCache?: () => void;
} };

async function control(options: AgentHostOptions, input: HostInput, log: RuntimeLog): Promise<RunResult | undefined> {
  if (input.parts.some((part) => part.type !== "text")) return undefined;
  const text = input.parts.map((part) => part.type === "text" ? part.text : "").join("\n").trim();
  const match = /^\/([a-zA-Z0-9_]+)(?:\s|$)/.exec(text);
  if (!match) return undefined;
  const name = match[1]!;
  const definition = AGENT_COMMANDS.find((item) => item.command === name);
  await log.append({ type: "command_received", command: name, messageId: input.metadata?.messageId, contextPolicy: "exclude" });
  if (!definition) return { text: "未知命令，请发送 /help 查看帮助。", kind: "control" };
  if (["help", "kvcache", "reset"].includes(name) && text !== `/${name}`)
    return { text: `用法：${definition.usage}`, kind: "control" };
  if (name === "help") return { text: AGENT_COMMANDS.map((item) => `${item.usage}\n${item.description}`).join("\n\n"), kind: "control" };
  if (name === "kvcache") {
    const cache = cacheStatistics(await options.log.read(), input.conversationId);
    return { text: cacheReportText(cache), cache, kind: "control" };
  }
  if (name === "reset") {
    await log.append({ type: "conversation_reset", source: "channel", contextPolicy: "exclude" });
    return { text: "已开始新上下文，旧记录和累计用量仍保留。", kind: "control" };
  }
  let response = "";
  const send = async (value: string) => { response = value; };
  const update: Update = { userId: conversationUserId(input.conversationId), chatType: "private", text,
    messageId: Number(input.metadata?.messageId ?? 0),
    ...(typeof input.metadata?.replyToMessageId === "number" ? { replyToMessageId: input.metadata.replyToMessageId } : {}) };
  const handled = name === "prompt" ? await handleCommand(log, { promptFile: options.promptFile, send }, update, text) :
    await handleMemoryCommand(log, { dataDir: options.dataDir, send, purgeEmbeddingCache: options.agent.purgeEmbeddingCache }, update, text);
  return { text: handled ? response : `用法：${definition.usage}`, kind: "control" };
}

/** Shared production Host for Telegram and CLI, including queued controls. */
export function createAgentHost(options: AgentHostOptions) {
  return createHost({ log: options.log, execute: async (input, context) => {
    const log = conversationLog(options.log, input.conversationId);
    if (input.metadata?.channel === "telegram" && typeof input.metadata.messageId === "number" &&
      (await log.read()).some((event) => event.messageId === input.metadata!.messageId &&
        (["input_received", "command_received"].includes(event.type) || event.type === "message" && event.role === "user")))
      return { kind: "duplicate" };
    const command = await control(options, input, log);
    if (command) return command;
    const text = input.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "请分析这张图片。";
    const images = input.parts.filter((part) => part.type === "image" && !!part.data)
      .map((part) => { if (part.type !== "image") throw new Error("图片格式无效"); return { type: "image" as const, mimeType: part.mimeType, data: part.data! }; });
    await log.append({ type: "message", role: "user", text, originalText: text, requestId: context.runId,
      chatId: conversationUserId(input.conversationId), messageId: input.metadata?.messageId, ...(images.length ? { images } : {}) });
    await log.append({ type: "request_started", requestId: context.runId });
    context.emit({ type: "progress", phase: "agent", source: "runtime", visibility: "normal", contextPolicy: "exclude", text: "处理中" });
    const history = await log.read();
    const configured = history.findLast((e) => e.type === "bot_prompt_config");
    try {
      const answer = await options.agent.answer(projectDeliveredChat(history), { id: context.runId, log, conversationId: input.conversationId,
        botPrompt: typeof configured?.text === "string" ? configured.text : undefined,
        botPromptVersion: typeof configured?.version === "string" ? configured.version : undefined });
      await log.append({ type: "answer_generated", requestId: context.runId, text: answer, resultId: context.runId });
      return { text: answer, resultId: context.runId, kind: "model" };
    } catch (error) {
      await log.append({ type: "request_failed", requestId: context.runId, error: String(error) });
      throw error;
    }
  } });
}
