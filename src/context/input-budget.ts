import type { Api, Context, Message, Model } from "@mariozechner/pi-ai";

export function modelInputBudget(model: Model<Api>, ratio?: number, ratios?: Record<string, number>) {
  const selected = ratios?.[`${model.provider}/${model.id}`] ?? ratio ?? 0.86;
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0 || !Number.isFinite(selected) || selected <= 0 || selected >= 1)
    throw new Error("模型窗口或 Projection 预算配置无效");
  const budget = Math.min(Math.floor(model.contextWindow * selected), model.contextWindow - model.maxTokens);
  if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0 || budget <= 0) throw new Error("模型输出预留或输入预算无效");
  return { budget, ratio: selected };
}

// Count all serialized input components; UTF-8 / 3 is an estimate, not provider usage.
export function estimateInput(context: Context): number {
  let imageTokens = 0;
  const countContent = (content: Message["content"]) => typeof content === "string" ? content : content.map((part) => {
    if (part.type !== "image") return part;
    // Conservative ceiling for Telegram photo sizes; encoded bytes are not text tokens.
    imageTokens += 16384;
    return { type: "image", mimeType: part.mimeType };
  });
  const messages = context.messages.map((m) => m.role === "assistant" ?
    { role: m.role, content: countContent(m.content) } : m.role === "toolResult" ?
      { role: m.role, toolCallId: m.toolCallId, toolName: m.toolName, content: countContent(m.content), isError: m.isError } :
      { role: m.role, content: countContent(m.content) });
  return Math.ceil(Buffer.byteLength(JSON.stringify({ system: context.systemPrompt ?? "", tools: context.tools ?? [], messages })) / 3) +
    imageTokens + 12 * (messages.length + (context.tools?.length ?? 0) + 1);
}

/** Feed is capped and never reduces an already higher configured budget. */
export function fedContextRatio(ratio: number): number {
  return Math.max(ratio, Math.min(0.9, ratio + 0.1));
}
