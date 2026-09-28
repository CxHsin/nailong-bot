import { randomUUID } from "node:crypto";
import { createRuntimeLog, type RuntimeLog } from "./runtime-log.js";

export type Update = { userId: number; chatType: string; text?: string; messageId: number };
export type Message = { role: "user" | "assistant"; text: string };
export type Request = { id: string; log: RuntimeLog };

export function createApp(options: {
  ownerId: number;
  dataDir: string;
  send: (text: string, update: Update, onChunk?: (index: number, total: number) => Promise<void>) => Promise<void>;
  answer: (messages: Message[], request: Request) => Promise<string>;
  contextChars?: number;
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
    await log.append({ type: "message", role: "user", text, messageId: update.messageId, requestId: id });
    await log.append({ type: "request_started", requestId: id });
    const history = await log.read();
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
    const limit = options.contextChars ?? 60_000;
    let size = messages.reduce((total, message) => total + message.text.length, 0);
    while (messages.length > 1 && size > limit) {
      size -= messages.shift()!.text.length;
    }
    while (messages.length > 1 && messages[0]?.role !== "user") messages.shift();
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
        await log.append({ type: "delivery_failed", requestId: id, error: String(error) });
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
      await options.send("抱歉，这条消息暂时处理失败，请稍后重试。", update);
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
