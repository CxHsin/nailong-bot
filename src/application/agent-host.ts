import { createHost, type HostEvent } from "../host/host.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { conversationLog, conversationUserId } from "../runtime/conversation-log.js";
import { agentCommand } from "./commands.js";
import { control } from "./control.js";
import type { AgentExecution } from "./agent-contract.js";
import { appendRuntimeFact, settledTextFact } from "../runtime/facts.js";
import { projectDeliveredChat } from "./runtime-projections.js";
import type { Request } from "./app-types.js";
import { commitMemoryLearning } from "./memory-learning.js";
import { cacheReplyContext } from "../runtime/reply-context.js";
import { deliverContent, type DeliveryContent, type ContentTransport } from "../runtime/content-delivery.js";
import { startProgressSummaries, progressSummaryOptions, type ProgressSummaryOptions } from "./progress-summaries.js";
import { recordInterruptedRuns, notifyRecovery } from "../runtime/startup-recovery.js";
import { projectTimeline } from "../runtime/timeline.js";
import { SkillReferenceError } from "../agent/skills.js";
import type { BuildIdentity } from "../runtime/build-identity.js";

export { AGENT_COMMANDS } from "./commands.js";

export type AgentHostOptions = { log: RuntimeLog; dataDir: string; promptFile: string; runtimeIdentity?: BuildIdentity; progressSummary?: ProgressSummaryOptions; agent: AgentExecution };

/** Shared production Host: queued model/mutation work and immediate cache diagnostics. */
export function createAgentHost(options: AgentHostOptions) {
  progressSummaryOptions(options.progressSummary);
  const host = createHost({ log: options.log,
    prepare: async (input, steering) => {
      const text = input.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (steering && agentCommand(text)) throw new SkillReferenceError("/steer 后请提供任务内容；控制命令请直接发送。");
      if (agentCommand(text)) return;
      if (options.agent.validateInput) input.metadata = { ...input.metadata, skillSnapshot: await options.agent.validateInput(text, String(input.metadata?.channel ?? "cli")) };
    },
    readOnly: (input) => input.parts.every((part) => part.type === "text") &&
      input.parts.map((part) => part.type === "text" ? part.text : "").join("\n").trim() === "/kvcache",
    execute: async (input, context) => {
    const log = conversationLog(options.log, input.conversationId);
    if (options.runtimeIdentity) await appendRuntimeFact(log, { type: "runtime_identity", requestId: context.runId, identity: options.runtimeIdentity, contextPolicy: "exclude" });
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
    await appendRuntimeFact(log, { type: "message", role: "user", text, originalText: text, requestId: context.runId,
      chatId: conversationUserId(input.conversationId), messageId: input.metadata?.messageId,
      ...(typeof replyToMessageId === "number" ? { replyToMessageId } : {}), ...(replyContext ? { replyContext } : {}),
      ...(images.length ? { images } : {}) });
    await appendRuntimeFact(log, { type: "request_started", requestId: context.runId });
    const results = new Map<string, string>();
    const history = await log.read();
    const feedIndex = history.findLastIndex((event) => event.type === "context_feed");
    const usedIndex = history.findLastIndex((event) => event.type === "context_feed_consumed");
    const fed = feedIndex > usedIndex;
    if (fed) await appendRuntimeFact(log, { type: "context_feed_consumed", requestId: context.runId, contextPolicy: "exclude" });
    const configured = history.findLast((e) => e.type === "bot_prompt_config");
    const selectedModel = history.findLast((event) => event.type === "model_selected");
    let summaries: ReturnType<typeof startProgressSummaries> | undefined;
    const request: Request = { modelAlias: typeof selectedModel?.modelAlias === "string" ? selectedModel.modelAlias : options.agent.defaultModel ?? options.agent.models?.[0]?.alias ?? "ds", ...(fed ? { contextBudgetBoost: true } : {}), id: context.runId, log, conversationId: input.conversationId, signal: context.signal, bindSteering: context.bindSteering,
      onProgress: (progress) => {
        if (progress.type === "text" && progress.source !== "progress-model") summaries?.primaryText(progress.finalized);
        if (progress.type === "text" && progress.kind === "result" && progress.finalized) results.set(progress.segmentId, progress.text);
        if (progress.type === "discard") results.delete(progress.segmentId);
        context.emit({ type: "progress", progress });
      }, botPrompt: typeof configured?.text === "string" ? configured.text : undefined,
      botPromptVersion: typeof configured?.version === "string" ? configured.version : undefined };
    if (options.agent.summarizeProgress) summaries = startProgressSummaries(request, text, options.agent.summarizeProgress, options.progressSummary);
    try {
      request.channel = typeof input.metadata?.channel === "string" ? input.metadata.channel : undefined;
      request.skillSnapshot = input.metadata?.skillSnapshot as Request["skillSnapshot"];
      const installation = await options.agent.installSkill?.(text, request);
      if (installation !== undefined) return { text: installation, kind: "control" };
      await options.agent.prepareCapabilities?.(text, request);
      const final = await options.agent.answer(projectDeliveredChat(history), request);
      summaries?.stop();
      // A protocol final may omit previously completed results; they must survive the draft.
      const answer = [...results.values(), final].join("\n\n");
      // Preserve the generated final separately from the Channel's assembled presentation.
      await appendRuntimeFact(log, { type: "answer_generated", requestId: context.runId, text: final, resultId: context.runId });
      const finalized = (await log.read()).map(settledTextFact).findLast((event) => event?.requestId === context.runId && event.contentKind === "final");
      return { text: answer, finalText: final, resultId: context.runId, kind: "model",
        ...(finalized?.text === final ? { finalSegmentId: finalized.textSegmentId } : {}),
        ...(results.size ? { stageSegmentIds: [...results.keys()] } : {}) };
    } catch (error) {
      await appendRuntimeFact(log, { type: "request_failed", requestId: context.runId, error: String(error) });
      if (error instanceof SkillReferenceError) return { text: error.message, kind: "control" };
      if (request.loadedSkillPaths?.length && error instanceof Error && /预算/.test(error.message))
        return { text: "skill 加载失败：完整指令超过本次模型输入预算。请缩小技能正文或使用更大的模型窗口。", kind: "control" };
      throw error;
    } finally {
      summaries?.stop();
    }
  } });
  return { ...host,
    recoverInterrupted: () => recordInterruptedRuns(options.log),
    notifyRecovery: (channel: "cli" | "telegram", send: (text: string, id: string) => Promise<void>) => notifyRecovery(options.log, channel, send),
    async readTimeline(conversationId: string) { return projectTimeline(await conversationLog(options.log, conversationId).read()); },
    async deliverContent(event: HostEvent, content: DeliveryContent, transport: ContentTransport, signal?: AbortSignal) {
      return deliverContent(conversationLog(options.log, event.conversationId), event.runId,
        conversationUserId(event.conversationId), content, transport, signal);
    },
    async recordProgress(event: HostEvent, fact: Record<string, unknown>) {
      await conversationLog(options.log, event.conversationId).append({ type: "telegram_progress_delivery", requestId: event.runId, contextPolicy: "exclude", ...fact });
    },
    async recordDelivery(event: HostEvent, delivery: { channel: "telegram" | "cli"; telegramMessageId?: number }) {
    if (event.type !== "run_succeeded") return;
    const log = conversationLog(options.log, event.conversationId);
    await appendRuntimeFact(log, { type: "delivery_succeeded", runId: event.runId, requestId: event.runId,
      resultId: String(event.result?.resultId ?? event.runId),
      ...(event.result?.stageSegmentIds ? { stageSegmentIds: event.result.stageSegmentIds } : {}), ...delivery });
    if (event.result?.kind !== "model") return;
    await appendRuntimeFact(log, { type: "request_completed", requestId: event.runId });
    await commitMemoryLearning(log, conversationUserId(event.conversationId), undefined, options.agent.memoryVector).catch(async () => {
      await appendRuntimeFact(log, { type: "memory_degraded", requestId: event.runId, reason: "learning_unavailable" }).catch(() => undefined);
    });
  } };
}
