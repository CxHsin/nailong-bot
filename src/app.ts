import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRuntimeLog, type RuntimeLog } from "./runtime-log.js";
import { createTelegramProjection, type TelegramTransport } from "./telegram-projection.js";
import { projectDeliveredChat, projectFinalAnswer, projectRecoverableTelegram,
  projectRequestState } from "./runtime-projections.js";

export type Update = { userId: number; chatType: string; text?: string; messageId: number };
export type Message = { role: "user" | "assistant"; text: string };
export type Request = { id: string; log: RuntimeLog; botPrompt?: string; botPromptVersion?: string; onText?: (textSegmentId: string) => Promise<void> };
export class DeliveryRejected extends Error {
  constructor(message: string, readonly retryAfterMs?: number) { super(message); }
}

export function createApp(options: {
  ownerId: number;
  dataDir: string;
  log?: RuntimeLog;
  promptFile?: string;
  telegram?: TelegramTransport;
  send: (text: string, update: Update, onChunk?: (index: number, total: number) => Promise<void>) => Promise<void>;
  answer: (messages: Message[], request: Request) => Promise<string>;
}) {
  const log: RuntimeLog = options.log ?? createRuntimeLog(options.dataDir);
  const telegram = options.telegram && createTelegramProjection({
    log, chatId: options.ownerId, ...options.telegram,
  });
  let queue = Promise.resolve();
  let pendingRequests = 0;

  function accepts(update: Update): update is Update & { text: string } {
    return update.userId === options.ownerId && update.chatType === "private" && !!update.text?.trim();
  }

  async function notice(requestId: string, text: string) {
    if (!telegram) return;
    const textSegmentId = `${requestId}:output-notice`;
    if (!(await log.read()).some((event) => event.textSegmentId === textSegmentId)) {
      const events = [{ type: "text_snapshot", requestId, textSegmentId, protocolVersion: "json-text-v2",
        contentKind: "notice", text }, { type: "text_finalized", requestId, textSegmentId,
        protocolVersion: "json-text-v2", contentKind: "notice", text }];
      if (log.appendBatch) await log.appendBatch(events);
      else for (const event of events) await log.append(event);
    }
    await telegram.reconcile(textSegmentId);
  }
  async function isNewOutput(requestId: string) {
    return (await log.read()).some((event) => event.type === "text_snapshot" &&
      event.requestId === requestId && event.protocolVersion === "json-text-v2");
  }

  async function process(update: Update & { text: string }, onStarted?: () => void): Promise<void> {
    telegram?.resume();
    if (pendingRequests > 1) telegram?.interrupt();
    const text = update.text.trim();
    if (/^\/prompt(?:\s|$)/.test(text)) {
      onStarted?.();
      if (text === "/prompt") {
        const configured = (await log.read()).findLast((e) => e.type === "bot_prompt_config" && e.chatId === update.userId);
        const prompt = typeof configured?.text === "string" ? configured.text :
          (await readFile(options.promptFile ?? resolve("system-prompt.md"), "utf8")).trim();
        await options.send(`当前 bot 提示词：\n${prompt}`, update);
      } else if (text === "/prompt reset" || text.startsWith("/prompt set ")) {
        const prompt = text === "/prompt reset" ? undefined : text.slice("/prompt set ".length).trim();
        if (prompt !== undefined && !prompt) { await options.send("请在 /prompt set 后提供非空提示词。", update); return; }
        await log.append({ type: "bot_prompt_config", chatId: update.userId, version: randomUUID(), text: prompt });
        await options.send(prompt === undefined ? "已恢复默认 bot 提示词，下一请求生效。" : "已设置当前聊天的 bot 提示词，下一请求生效。", update);
      } else await options.send("查看：/prompt；设置：/prompt set 提示词；恢复默认：/prompt reset", update);
      return;
    }
    if (text === "/reset") {
      const batch = [{ type: "message", role: "user", text, messageId: update.messageId },
        { type: "reset" }];
      if (log.appendBatch) await log.appendBatch(batch);
      else for (const event of batch) await log.append(event);
      onStarted?.();
      await options.send("已开始新对话，旧记录仍保留在本地。", update);
      return;
    }
    const id = randomUUID();
    let history: Awaited<ReturnType<typeof log.read>>;
    try {
      const previous = await log.read();
      const reset = previous.findLastIndex((event) => event.type === "reset");
      const active = projectRequestState(previous.slice(reset + 1)).open;
      // Requests are serialized by this app. An older open request cannot still be running here.
      for (const requestId of active) await log.append({ type: "request_interrupted", requestId });
      const batch = [{ type: "message", role: "user", text, messageId: update.messageId, requestId: id },
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
          const event = (await log.read()).findLast((e) => e.type === "text_finalized" && e.textSegmentId === segment);
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
    }
  }

  return {
    async recover(): Promise<void> {
      const events = await log.read();
      const open = projectRequestState(events).open;
      for (const requestId of open) await log.append({ type: "request_interrupted", requestId });
      if (telegram) {
        const { segments } = projectRecoverableTelegram(events);
        for (const segment of segments) {
          const snapshot = events.findLast((event) => event.type === "text_snapshot" && event.textSegmentId === segment);
          // V2 recovery never sends old body content; only durable notices may retry known failures.
          const knownFailure = events.some((event) => event.type === "telegram_delivery_failed" && event.textSegmentId === segment);
          if (snapshot?.protocolVersion !== "json-text-v2" || snapshot.contentKind === "notice" || knownFailure) await telegram.reconcile(segment);
        }
        const unfinished = new Set(events.filter((event) => event.type === "text_snapshot" &&
          event.protocolVersion === "json-text-v2" && event.contentKind !== "notice" && event.requestId &&
          !projectRequestState(events).delivered.has(event.requestId)).map((event) => event.requestId!));
        for (const requestId of unfinished) {
          const final = events.findLast((event) => event.type === "text_finalized" && event.requestId === requestId && event.contentKind === "final");
          if (!await telegram.requestDelivered(requestId) || !final || !await telegram.finalDelivered(String(final.textSegmentId))) {
            await notice(requestId, "这次回复可能不完整：处理曾中断。已发送内容保留；你可以要求继续或重新发送。");
          }
        }
        const current = await log.read();
        for (const event of projectRecoverableTelegram(current).finals) {
          if (!await telegram.finalDelivered(String(event.textSegmentId)) || !await telegram.requestDelivered(event.requestId!) ||
            projectRequestState(current).delivered.has(event.requestId!)) continue;
          if (!current.some((item) => item.type === "answer_generated" && item.requestId === event.requestId)) {
            await log.append({ type: "answer_generated", requestId: event.requestId, text: event.text });
          }
          await log.append({ type: "delivery_succeeded", requestId: event.requestId,
            textSegmentId: event.textSegmentId });
        }
      }
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
