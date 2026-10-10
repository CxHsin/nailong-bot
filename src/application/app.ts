import { createDeliveryLifecycle } from "../telegram/telegram-delivery.js";
import { handleLegacyCommand, handleLegacyMemoryCommand } from "./legacy-commands.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRuntimeLog } from "../runtime/runtime-log.js";
import { createEventReader } from "../runtime/event-reader.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { createTelegramProjection } from "../telegram/telegram-projection.js";
import type { TelegramTransport } from "../telegram/telegram-types.js";
import { projectDeliveredChat, projectFinalAnswer,
  projectRequestState } from "./runtime-projections.js";
import { commitMemoryLearning } from "./memory-learning.js";
import type { MemoryDynamics } from "../memory/dynamics.js";


import { DeliveryRejected, type Update, type Message, type Request } from "./app-types.js";
export { DeliveryRejected, type Update, type Message, type Request } from "./app-types.js";

export function createApp(options: {
  ownerId: number;
  dataDir: string;
  log?: RuntimeLog;
  promptFile?: string;
  telegram?: TelegramTransport;
  send: (text: string, update: Update, onChunk?: (index: number, total: number) => Promise<void>) => Promise<void>;
  answer: (messages: Message[], request: Request) => Promise<string>;
  memoryDynamics?: Partial<MemoryDynamics>;
  memoryVector?: (text: string) => number[] | undefined;
  purgeEmbeddingCache?: () => void;
}) {
  const log: RuntimeLog = options.log ?? createRuntimeLog(options.dataDir);
  const readEvents = createEventReader(log);
  const telegram = options.telegram && createTelegramProjection({
    log, chatId: options.ownerId, ...options.telegram,
  });
  let queue = Promise.resolve();
  let pendingRequests = 0;

  function accepts(update: Update): boolean {
    return update.userId === options.ownerId && update.chatType === "private" && (!!update.text?.trim() || !!update.images?.length);
  }

  const delivery = createDeliveryLifecycle(log, telegram);
  const { notice, isNewOutput } = delivery;

  async function process(update: Update, onStarted?: () => void): Promise<void> {
    let previous: Awaited<ReturnType<typeof log.read>>;
    try {
      previous = await readEvents();
      // Input identities outlive /reset and include records written before receipts existed.
      if (previous.some((event) => event.messageId === update.messageId &&
        (event.type === "input_received" || event.type === "message" && event.role === "user") &&
        (event.chatId === update.userId || event.chatId === undefined && event.type === "message"))) {
        onStarted?.();
        return;
      }
    } catch (error) {
      try { await options.send("抱歉，本地运行日志暂时不可用，本条请求没有开始执行。", update); }
      catch { /* Preserve the storage failure. */ }
      throw error;
    }
    telegram?.resume();
    if (pendingRequests > 1) telegram?.interrupt();
    const text = update.text?.trim() || "请分析这张图片。";
    if (await handleLegacyMemoryCommand(log, options, update, text, onStarted)) return;
    if (await handleLegacyCommand(log, options, update, text, onStarted)) return;
    const id = randomUUID();
    let history: Awaited<ReturnType<typeof log.read>>;
    try {
      const reset = previous.findLastIndex((event) => event.type === "reset");
      const active = projectRequestState(previous.slice(reset + 1)).open;
      // Requests are serialized by this app. An older open request cannot still be running here.
      for (const requestId of active) await log.append({ type: "request_interrupted", requestId });
      const batch = [{ type: "message", role: "user", text, chatId: update.userId, messageId: update.messageId, requestId: id,
        replyToMessageId: update.replyToMessageId,
        originalText: update.text ?? null,
        ...(update.images?.length ? { images: update.images } : {}) },
        { type: "request_started", requestId: id }];
      if (log.appendBatch) await log.appendBatch(batch);
      else for (const event of batch) await log.append(event);
      onStarted?.();
      history = await log.read();
    } catch (error) {
      try { await options.send("抱歉，本地运行日志暂时不可用，本条请求没有开始执行。", update); }
      catch { /* The storage error remains the request failure. */ }
      throw error;
    }
    const messages = projectDeliveredChat(history);
    try {
      const configured = history.findLast((e) => e.type === "bot_prompt_config" && e.chatId === update.userId);
      const answer = await options.answer(messages, { id, log,
        botPrompt: typeof configured?.text === "string" ? configured.text : undefined,
        botPromptVersion: typeof configured?.version === "string" ? configured.version : undefined, onText: telegram ? async (segment) => {
          const event = (await readEvents()).findLast((e) => e.type === "text_finalized" && e.textSegmentId === segment);
          if (event?.contentKind === "progress" || event?.contentKind === "result") await telegram.reconcile(segment);
          else await telegram.stream(segment);
        } : undefined });
      if (!answer.trim()) throw new Error("模型没有返回文字");
      await telegram?.finish();
      await log.append({ type: "answer_generated", requestId: id, text: answer });
      const final = telegram && projectFinalAnswer(await log.read(), id, answer);
      if (final && telegram) {
        await telegram.reconcile(String(final.textSegmentId));
        if (await telegram.finalDelivered(String(final.textSegmentId)) && await telegram.requestDelivered(id)) {
          await log.append({ type: "delivery_succeeded", requestId: id, textSegmentId: final.textSegmentId });
          await log.append({ type: "request_completed", requestId: id });
        } else {
          await log.append({ type: "request_failed", requestId: id, phase: "delivery" });
          if (await isNewOutput(id)) await notice(id, "这次回复可能不完整：部分消息尚未确认送达。明确失败会重试，送达状态不明的内容不会自动重发；你可以要求重新发送。");
        }
        return;
      }
      try {
        await options.send(answer, update, async (index, total) => {
          await log.append({ type: "delivery_chunk_succeeded", requestId: id, index, total });
        });
      }
      catch (error) {
        await log.append({ type: error instanceof DeliveryRejected ? "delivery_failed" : "delivery_unknown",
          requestId: id, error: String(error) });
        await log.append({ type: "request_failed", requestId: id, phase: "delivery" });
        throw error;
      }
      await log.append({ type: "delivery_succeeded", requestId: id });
      await log.append({ type: "request_completed", requestId: id });
    } catch (error) {
      await telegram?.stop();
      try {
        const events = await log.read();
        if (!projectRequestState(events).failed.has(id)) {
          await log.append({ type: "request_failed", requestId: id, phase: "agent", error: String(error) });
        }
      }
      catch { /* Preserve the original storage failure. */ }
      const safeReason = error instanceof Error &&
        /^(上下文超过预算|工具归档缺失或校验失败|模型窗口或 Projection 预算配置无效|历史摘要|模型上下文溢出|模型协议|模型连续|模型未提交)/.test(error.message)
        ? `：${error.message}` : "，请稍后重试";
      if (telegram && await isNewOutput(id)) {
        await notice(id, "这次回复尚未完成，已发送内容保留。你可以要求继续或重新生成。");
      } else await options.send(`抱歉，这条消息暂时处理失败${safeReason}。`, update);
    } finally {
      await commitMemoryLearning(log, options.ownerId, options.memoryDynamics, options.memoryVector).catch(async () => {
        await log.append({ type: "memory_degraded", requestId: id, reason: "learning_commit_unavailable" }).catch(() => undefined);
      });
    }
  }

  return {
    recover(): Promise<void> {
      const next = queue.then(async () => { await delivery.recover(); await commitMemoryLearning(log, options.ownerId, options.memoryDynamics, options.memoryVector); });
      queue = next.catch(() => undefined);
      return next;
    },
    handle(update: Update, onStarted?: () => void): Promise<void> {
      if (!accepts(update)) return Promise.resolve();
      pendingRequests++;
      telegram?.interrupt();
      const next = queue.then(() => process(update, onStarted)).finally(() => { pendingRequests--; });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
