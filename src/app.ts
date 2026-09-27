import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type Update = { userId: number; chatType: string; text?: string; messageId: number };
export type Message = { role: "user" | "assistant"; text: string };
type Event =
  | { type: "message"; role: "user" | "assistant"; text: string; at: string; messageId?: number }
  | { type: "reset"; at: string };

export function createApp(options: {
  ownerId: number;
  dataDir: string;
  send: (text: string, update: Update) => Promise<void>;
  answer: (messages: Message[]) => Promise<string>;
  contextChars?: number;
}) {
  const eventFile = join(options.dataDir, "events.jsonl");
  let queue = Promise.resolve();

  async function events(): Promise<Event[]> {
    let content: string;
    try { content = await readFile(eventFile, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event);
  }

  async function append(event: Event): Promise<void> {
    await mkdir(options.dataDir, { recursive: true });
    await appendFile(eventFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  }

  async function process(update: Update): Promise<void> {
    if (update.userId !== options.ownerId || update.chatType !== "private" || !update.text?.trim()) return;
    const text = update.text.trim();
    if (text === "/reset") {
      await append({ type: "message", role: "user", text, at: new Date().toISOString(), messageId: update.messageId });
      await append({ type: "reset", at: new Date().toISOString() });
      await options.send("已开始新对话，旧记录仍保留在本地。", update);
      return;
    }
    await append({ type: "message", role: "user", text, at: new Date().toISOString(), messageId: update.messageId });
    const history = await events();
    const resetIndex = history.findLastIndex((event) => event.type === "reset");
    let messages: Message[] = history.slice(resetIndex + 1).filter((event) => event.type === "message")
      .map((event) => ({ role: event.role, text: event.text }));
    const limit = options.contextChars ?? 60_000;
    let size = messages.reduce((total, message) => total + message.text.length, 0);
    while (messages.length > 1 && size > limit) {
      size -= messages.shift()!.text.length;
    }
    while (messages.length > 1 && messages[0]?.role !== "user") messages.shift();
    try {
      const answer = await options.answer(messages);
      if (!answer.trim()) throw new Error("模型没有返回文字");
      await options.send(answer, update);
      await append({ type: "message", role: "assistant", text: answer, at: new Date().toISOString() });
    } catch {
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
