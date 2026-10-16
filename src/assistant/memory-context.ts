import type { Message } from "@earendil-works/pi-ai";
import type { AssistantMemory, SummaryInvalidation } from "./memory.js";

/** Forgetting invalidates automatic derivatives, while original records remain on disk. */
export async function sanitizeMemoryContext(messages: readonly Message[], memory: AssistantMemory,
  conversationId: string, generation: string, project: string, options: {
    summaryTaskId?: string | number;
    rebuildSummary?: (info: SummaryInvalidation) => Promise<string>;
  } = {}): Promise<readonly Message[]> {
  const excluded = memory.invalidatedSources();
  if (!excluded.length) return messages;
  const forbidden = new Set(excluded.map((source) => source.id));
  const containsExcluded = (text: string) => [...forbidden].some((id) => text.includes(id));
  const summary = options.summaryTaskId === undefined ? undefined : memory.invalidationInfo(conversationId, options.summaryTaskId);
  const replacement = summary?.affected ? await options.rebuildSummary?.(summary) : undefined;
  if (summary?.affected && replacement === undefined) throw new Error("Affected compaction summary requires reconstruction from surviving originals and confirmed effects");
  return messages.map((message) => {
    if (message.role === "system" && message.sections?.memory) return { ...message,
      sections: { ...message.sections, memory: `<memory>\n${memory.snapshot(conversationId, generation, project)}\n</memory>` } };
    if (message.role === "toolResult" && message.toolName.startsWith("memory_") && containsExcluded(JSON.stringify(message.content))) {
      return { ...message, content: [{ type: "text" as const, text: "此历史记忆结果因用户遗忘已失效。使用当前记忆工具获取仍有效的材料。" }] };
    }
    if (message.role === "assistant") {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (text && excluded.some((source) => source.text === text)) return { ...message,
        content: message.content.map((part) => part.type === "text" ? { ...part, text: "此助手历史派生内容因用户遗忘或纠正已失效。" } : part) };
    }
    if (message.role !== "user") return message;
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    return { ...message, content: content.map((part) => {
      if (part.type !== "text") return part;
      const eventIdentity = part.text.match(/^<event identity=("(?:[^"\\]|\\.)*")/);
      if (eventIdentity) {
        const inputId: unknown = JSON.parse(eventIdentity[1]!);
        if (excluded.some((entry) => {
          const source = memory.getSource(entry.id);
          return source?.conversationId === conversationId && source.inputId === inputId;
        })) return { ...part, text: "此历史输入的自动上下文因用户遗忘或纠正已失效；原始记录保留。" };
      }
      if (replacement !== undefined && part.text.startsWith("The conversation history before this point was compacted")) {
        return { ...part, text: part.text.replace(/<summary>[\s\S]*?<\/summary>/, `<summary>\n${replacement}\n</summary>`) };
      }
      if (part.text.startsWith("记忆检索材料") && containsExcluded(part.text)) {
        const input = part.text.match(/sourceId=(source:[a-f0-9]{64})/)?.[1];
        return { ...part, text: input && !forbidden.has(input) ? memory.prepareInput(conversationId, input, project) : "历史自动记忆材料因遗忘已排除。" };
      }
      if (part.text.startsWith("记忆变更材料") && containsExcluded(part.text)) return { ...part, text: "历史记忆变更因遗忘或纠正已排除。" };
      return part;
    }) };
  });
}
