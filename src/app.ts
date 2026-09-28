import { randomUUID } from "node:crypto";
import { createRuntimeLog, type RuntimeLog } from "./runtime-log.js";

export type Update = { userId: number; chatType: string; text?: string; messageId: number };
export type Message = { role: "user" | "assistant"; text: string };
export type Request = { id: string; log: RuntimeLog };
export class DeliveryRejected extends Error {}

export function createApp(options: {
  ownerId: number;
  dataDir: string;
  send: (text: string, update: Update, onChunk?: (index: number, total: number) => Promise<void>) => Promise<void>;
  answer: (messages: Message[], request: Request) => Promise<string>;
}) {
  const log = createRuntimeLog(options.dataDir);
  let queue = Promise.resolve();

  async function process(update: Update): Promise<void> {
    if (update.userId !== options.ownerId || update.chatType !== "private" || !update.text?.trim()) return;
    const text = update.text.trim();
    if (text === "/reset") {
      await log.append({ type: "message", role: "user", text, messageId: update.messageId });
      await log.append({ type: "reset" });
      await options.send("已开始新对话，旧记录仍保留在本地。", update);
      return;
    }
    const id = randomUUID();
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
      await log.append({ type: "message", role: "user", text, messageId: update.messageId, requestId: id });
      await log.append({ type: "request_started", requestId: id });
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
      const answer = await options.answer(messages, { id, log });
      if (!answer.trim()) throw new Error("模型没有返回文字");
      await log.append({ type: "answer_generated", requestId: id, text: answer });
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
    handle(update: Update): Promise<void> {
      const next = queue.then(() => process(update));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
