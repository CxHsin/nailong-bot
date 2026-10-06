import { createHost, type HostEvent, type HostInput, type RunResult } from "../host/host.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { conversationLog, conversationUserId } from "../runtime/conversation-log.js";
import { handleCommand } from "./commands.js";
import { handleMemoryCommand } from "./memory-commands.js";
import { projectDeliveredChat } from "./runtime-projections.js";
import type { Message, Request, Update } from "./app-types.js";
import { cacheStatistics, cacheReportText } from "../runtime/cache-statistics.js";
import { commitMemoryLearning } from "./memory-learning.js";
import { cacheReplyContext } from "../runtime/reply-context.js";
import { deliverContent, type DeliveryContent, type ContentTransport } from "../runtime/content-delivery.js";
import { startProgressSummaries, progressSummaryOptions, type ProgressSummaryOptions, type ProgressSummaryGenerator } from "./progress-summaries.js";
import { recordInterruptedRuns } from "../runtime/startup-recovery.js";
import { projectTimeline } from "../runtime/timeline.js";

export const AGENT_COMMANDS = [
  { command: "help", description: "查看命令帮助", usage: "/help" },
  { command: "kvcache", description: "查看最近五组运行的缓存详情", usage: "/kvcache" },
  { command: "model", description: "查看或切换当前对话模型", usage: "/model；/model ds；/model gpt" },
  { command: "dance", description: "看奶龙扭秧歌", usage: "/dance" },
  { command: "feed", description: "喂奶龙小面包，提升下一轮上下文预算", usage: "/feed" },
  { command: "reset", description: "开始新上下文，保留记录和累计统计", usage: "/reset" },
  { command: "prompt", description: "查看、设置或恢复 bot 提示词", usage: "/prompt；/prompt set 提示词；/prompt reset" },
  { command: "forget", description: "排除指定旧轮次的记忆和上下文", usage: "/forget 节点引用；回复目标消息发送 /forget" },
  { command: "memory", description: "诊断查阅原始轮次日志", usage: "/memory log 节点引用 [字符位置]" },
] as const;

type AgentHostOptions = { log: RuntimeLog; dataDir: string; promptFile: string; progressSummary?: ProgressSummaryOptions; agent: {
  answer(messages: Message[], request: Request): Promise<string>; purgeEmbeddingCache?: () => void;
  summarizeProgress?: ProgressSummaryGenerator;
  models?: ReadonlyArray<{ alias: "ds" | "gpt"; name: string }>;
  memoryVector?: (text: string) => number[] | undefined;
} };

async function control(options: AgentHostOptions, input: HostInput, log: RuntimeLog): Promise<RunResult | undefined> {
  if (input.parts.some((part) => part.type !== "text")) return undefined;
  const text = input.parts.map((part) => part.type === "text" ? part.text : "").join("\n").trim();
  if (!text.startsWith("/")) return undefined;
  const match = /^\/([a-zA-Z0-9_]+)(?:\s|$)/.exec(text);
  const name = match?.[1] ?? text.slice(1).split(/\s/, 1)[0]!;
  const definition = AGENT_COMMANDS.find((item) => item.command === name);
  await log.append({ type: "command_received", command: name, messageId: input.metadata?.messageId, contextPolicy: "exclude" });
  if (!definition) return { text: "未知命令，请发送 /help 查看帮助。", kind: "control" };
  if (["help", "kvcache", "reset", "feed", "dance"].includes(name) && text !== `/${name}`)
    return { text: `用法：${definition.usage}`, kind: "control" };
  if (name === "help") return { text: AGENT_COMMANDS.map((item) => `${item.usage}\n${item.description}`).join("\n\n"), kind: "control" };
  if (name === "model") {
    const models = options.agent.models ?? [{ alias: "ds", name: "DeepSeek" }];
    const selected = (await log.read()).findLast((event) => event.type === "model_selected");
    const current = selected?.modelAlias === "gpt" ? "gpt" : "ds";
    if (text === "/model") return { text: `当前模型：${current}\n可选模型：\n${models.map((item) => `${item.alias}：${item.name}`).join("\n")}\n用法：/model ds 或 /model gpt`, kind: "control" };
    const alias = text.slice("/model ".length).trim();
    if (!/^\/model\s+(ds|gpt)$/.test(text)) return { text: `用法：${definition.usage}`, kind: "control" };
    if (!models.some((item) => item.alias === alias)) return { text: "GPT 尚未配置，请先设置 XH_API_KEY。当前模型未改变。", kind: "control" };
    await log.append({ type: "model_selected", modelAlias: alias, contextPolicy: "exclude" });
    return { text: `已切换为 ${alias}，从下一轮生效。`, kind: "control" };
  }
  if (name === "kvcache") {
    const cache = cacheStatistics(await options.log.read(), input.conversationId);
    return { text: cacheReportText(cache), cache, kind: "control" };
  }
  if (name === "dance") return { text: "奶龙扭起来啦！", stickerCategory: "dance", kind: "control" };
  if (name === "feed") {
    await log.append({ type: "context_feed", contextPolicy: "exclude" });
    return { text: "你喂了奶龙一个奶香小面包，奶龙满足地拍了拍肚皮，现在的上下文精神头提升了 100%！", stickerCategory: "feed", stickerText: true, kind: "control" };
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
    await handleMemoryCommand(log, { dataDir: options.dataDir, conversationId: input.conversationId, send, purgeEmbeddingCache: options.agent.purgeEmbeddingCache }, update, text);
  return { text: handled ? response : `用法：${definition.usage}`, kind: "control" };
}

/** Shared production Host: queued model/mutation work and immediate cache diagnostics. */
export function createAgentHost(options: AgentHostOptions) {
  progressSummaryOptions(options.progressSummary);
  const host = createHost({ log: options.log,
    readOnly: (input) => input.parts.every((part) => part.type === "text") &&
      input.parts.map((part) => part.type === "text" ? part.text : "").join("\n").trim() === "/kvcache",
    execute: async (input, context) => {
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
    const replyToMessageId = input.metadata?.replyToMessageId;
    const replyContext = input.metadata?.channel === "telegram" && typeof replyToMessageId === "number" &&
      Number.isSafeInteger(replyToMessageId) && replyToMessageId > 0 ? cacheReplyContext(await log.read(), replyToMessageId) : undefined;
    await log.append({ type: "message", role: "user", text, originalText: text, requestId: context.runId,
      chatId: conversationUserId(input.conversationId), messageId: input.metadata?.messageId,
      ...(typeof replyToMessageId === "number" ? { replyToMessageId } : {}), ...(replyContext ? { replyContext } : {}),
      ...(images.length ? { images } : {}) });
    await log.append({ type: "request_started", requestId: context.runId });
    const results = new Map<string, string>();
    const history = await log.read();
    const feedIndex = history.findLastIndex((event) => event.type === "context_feed");
    const usedIndex = history.findLastIndex((event) => event.type === "context_feed_consumed");
    const fed = feedIndex > usedIndex;
    if (fed) await log.append({ type: "context_feed_consumed", requestId: context.runId, contextPolicy: "exclude" });
    const configured = history.findLast((e) => e.type === "bot_prompt_config");
    const selectedModel = history.findLast((event) => event.type === "model_selected");
    let summaries: ReturnType<typeof startProgressSummaries> | undefined;
    const request: Request = { modelAlias: selectedModel?.modelAlias === "gpt" ? "gpt" : "ds", ...(fed ? { contextBudgetBoost: true } : {}), id: context.runId, log, conversationId: input.conversationId, signal: context.signal,
      onProgress: (progress) => {
        if (progress.type === "text" && progress.source !== "progress-model") summaries?.primaryText(progress.finalized);
        if (progress.type === "text" && progress.kind === "result" && progress.finalized) results.set(progress.segmentId, progress.text);
        if (progress.type === "discard") results.delete(progress.segmentId);
        context.emit({ type: "progress", progress });
      }, botPrompt: typeof configured?.text === "string" ? configured.text : undefined,
      botPromptVersion: typeof configured?.version === "string" ? configured.version : undefined };
    if (options.agent.summarizeProgress) summaries = startProgressSummaries(request, text, options.agent.summarizeProgress, options.progressSummary);
    try {
      const final = await options.agent.answer(projectDeliveredChat(history), request);
      summaries?.stop();
      // A protocol final may omit previously completed results; they must survive the draft.
      const answer = [...results.values(), final].join("\n\n");
      // Preserve the generated final separately from the Channel's assembled presentation.
      await log.append({ type: "answer_generated", requestId: context.runId, text: final, resultId: context.runId });
      const finalized = (await log.read()).findLast((event) => event.type === "text_finalized" && event.requestId === context.runId && event.contentKind === "final");
      return { text: answer, finalText: final, resultId: context.runId, kind: "model",
        ...(finalized ? { finalSegmentId: finalized.textSegmentId } : {}),
        ...(results.size ? { stageSegmentIds: [...results.keys()] } : {}) };
    } catch (error) {
      await log.append({ type: "request_failed", requestId: context.runId, error: String(error) });
      throw error;
    } finally {
      summaries?.stop();
    }
  } });
  return { ...host,
    recoverInterrupted: () => recordInterruptedRuns(options.log),
    async readTimeline(conversationId: string) { return projectTimeline(await conversationLog(options.log, conversationId).read()); },
    async deliverContent(event: HostEvent, content: DeliveryContent, transport: ContentTransport) {
      return deliverContent(conversationLog(options.log, event.conversationId), event.runId,
        conversationUserId(event.conversationId), content, transport);
    },
    async recordProgress(event: HostEvent, fact: Record<string, unknown>) {
      await conversationLog(options.log, event.conversationId).append({ type: "telegram_progress_delivery", requestId: event.runId, contextPolicy: "exclude", ...fact });
    },
    async recordDelivery(event: HostEvent, delivery: { channel: "telegram" | "cli"; telegramMessageId?: number }) {
    if (event.type !== "run_succeeded") return;
    const log = conversationLog(options.log, event.conversationId);
    await log.append({ type: "delivery_succeeded", runId: event.runId, requestId: event.runId,
      resultId: String(event.result?.resultId ?? event.runId),
      ...(event.result?.stageSegmentIds ? { stageSegmentIds: event.result.stageSegmentIds } : {}), ...delivery });
    if (event.result?.kind !== "model") return;
    await log.append({ type: "request_completed", requestId: event.runId });
    await commitMemoryLearning(log, conversationUserId(event.conversationId), undefined, options.agent.memoryVector).catch(async () => {
      await log.append({ type: "memory_degraded", requestId: event.runId, reason: "learning_unavailable" }).catch(() => undefined);
    });
  } };
}
