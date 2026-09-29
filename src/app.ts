import { randomUUID } from "node:crypto";
import { createRuntimeLog, type RuntimeLog } from "./runtime-log.js";
import { createTelegramProjection, type TelegramTransport } from "./telegram-projection.js";

export type Update = { userId: number; chatType: string; text?: string; messageId: number };
export type Message = { role: "user" | "assistant"; text: string };
export type Request = { id: string; log: RuntimeLog; onText?: (textSegmentId: string) => Promise<void> };
export class DeliveryRejected extends Error {}

export function createApp(options: {
  ownerId: number;
  dataDir: string;
  log?: RuntimeLog;
  telegram?: TelegramTransport;
  send: (text: string, update: Update, onChunk?: (index: number, total: number) => Promise<void>) => Promise<void>;
  answer: (messages: Message[], request: Request) => Promise<string>;
}) {
  const log: RuntimeLog = options.log ?? createRuntimeLog(options.dataDir);
  let queue = Promise.resolve();

  async function process(update: Update): Promise<void> {
    if (update.userId !== options.ownerId || update.chatType !== "private" || !update.text?.trim()) return;
    const text = update.text.trim();
    if (text === "/reset") {
      const batch = [{ type: "message", role: "user", text, messageId: update.messageId },
        { type: "reset" }];
      if (log.appendBatch) await log.appendBatch(batch);
      else for (const event of batch) await log.append(event);
      await options.send("已开始新对话，旧记录仍保留在本地。", update);
      return;
    }
    const id = randomUUID();
    const telegram = options.telegram && createTelegramProjection({
      log, chatId: update.userId, ...options.telegram,
    });
    let history: Awaited<ReturnType<typeof log.read>>;
    try {
      const previous = await log.read();
      const reset = previous.findLastIndex((event) => event.type === "reset");
      const active = new Set(previous.slice(reset + 1).filter((event) => event.type === "request_started")
        .map((event) => event.requestId).filter((value): value is string => !!value));
      for (const event of previous.slice(reset + 1)) {
        if (event.type === "request_completed" || event.type === "request_failed" ||
          event.type === "request_interrupted") {
          if (event.requestId) active.delete(event.requestId);
        }
      }
      // Requests are serialized by this app. An older open request cannot still be running here.
      for (const requestId of active) await log.append({ type: "request_interrupted", requestId });
      const batch = [{ type: "message", role: "user", text, messageId: update.messageId, requestId: id },
        { type: "request_started", requestId: id }];
      if (log.appendBatch) await log.appendBatch(batch);
      else for (const event of batch) await log.append(event);
      history = await log.read();
    } catch (error) {
      try { await options.send("抱歉，本地运行日志暂时不可用，本条请求没有开始执行。", update); }
      catch { /* The storage error remains the request failure. */ }
      throw error;
    }
    const resetIndex = history.findLastIndex((event) => event.type === "reset");
    const generated = new Map<string, string>();
    let messages: Message[] = [];
    for (const event of history.slice(resetIndex + 1)) {
      if (event.type === "message" && event.role === "user" && typeof event.text === "string") {
        messages.push({ role: "user", text: event.text });
      } else if (event.type === "message" && event.role === "assistant" && !event.requestId &&
        typeof event.text === "string") {
        messages.push({ role: "assistant", text: event.text });
      } else if (event.type === "answer_generated" && event.requestId && typeof event.text === "string") {
        generated.set(event.requestId, event.text);
      } else if (event.type === "delivery_succeeded" && event.requestId) {
        const delivered = generated.get(event.requestId);
        if (delivered !== undefined) messages.push({ role: "assistant", text: delivered });
      }
    }
    try {
      const answer = await options.answer(messages, { id, log, onText: telegram?.reconcile });
      if (!answer.trim()) throw new Error("模型没有返回文字");
      await log.append({ type: "answer_generated", requestId: id, text: answer });
      const final = telegram && (await log.read()).findLast((event) =>
        event.type === "text_finalized" && event.requestId === id && event.contentKind === "final" &&
        event.text === answer && typeof event.textSegmentId === "string");
      if (final && telegram) {
        await telegram.reconcile(String(final.textSegmentId));
        if (await telegram.finalDelivered(String(final.textSegmentId))) {
          await log.append({ type: "delivery_succeeded", requestId: id, textSegmentId: final.textSegmentId });
          await log.append({ type: "request_completed", requestId: id });
        } else {
          await log.append({ type: "request_failed", requestId: id, phase: "delivery" });
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
      try {
        const events = await log.read();
        if (!events.some((event) => event.type === "request_failed" && event.requestId === id)) {
          await log.append({ type: "request_failed", requestId: id, phase: "agent", error: String(error) });
        }
      }
      catch { /* Preserve the original storage failure. */ }
      const safeReason = error instanceof Error &&
        /^(上下文超过预算|工具归档缺失或校验失败|模型窗口或 Projection 预算配置无效|历史摘要|模型上下文溢出)/.test(error.message)
        ? `：${error.message}` : "，请稍后重试";
      await options.send(`抱歉，这条消息暂时处理失败${safeReason}。`, update);
    }
  }

  return {
    async recover(): Promise<void> {
      const events = await log.read();
      const open = new Set(events.filter((event) => event.type === "request_started")
        .map((event) => event.requestId).filter((id): id is string => typeof id === "string"));
      for (const event of events) {
        if (["request_completed", "request_failed", "request_interrupted"].includes(event.type) && event.requestId) {
          open.delete(event.requestId);
        }
      }
      for (const requestId of open) await log.append({ type: "request_interrupted", requestId });
      if (options.telegram) {
        const segments = [...new Set(events.filter((event) => event.type === "text_snapshot" &&
          typeof event.textSegmentId === "string").map((event) => event.textSegmentId as string))];
        const telegram = createTelegramProjection({ log, chatId: options.ownerId, ...options.telegram });
        for (const segment of segments) await telegram.reconcile(segment);
        const current = await log.read();
        for (const event of current.filter((item) => item.type === "text_finalized" &&
          item.contentKind === "final" && typeof item.textSegmentId === "string" &&
          typeof item.requestId === "string" && typeof item.text === "string")) {
          if (!await telegram.finalDelivered(String(event.textSegmentId)) ||
            current.some((item) => item.type === "delivery_succeeded" && item.requestId === event.requestId)) continue;
          if (!current.some((item) => item.type === "answer_generated" && item.requestId === event.requestId)) {
            await log.append({ type: "answer_generated", requestId: event.requestId, text: event.text });
          }
          await log.append({ type: "delivery_succeeded", requestId: event.requestId,
            textSegmentId: event.textSegmentId });
        }
      }
    },
    handle(update: Update): Promise<void> {
      const next = queue.then(() => process(update));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
