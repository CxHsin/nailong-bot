import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";

export function assistantText(text: string, model: Model<Api>, timestamp = Date.now()): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: model.api,
    provider: model.provider, model: model.id, stopReason: "stop", timestamp,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
