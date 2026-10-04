import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";
import type { Request } from "../application/app-types.js";

/** SDK usage is replaced when a Provider usage chunk arrives; error placeholders are not measurements. */
export function hasProviderUsage(message: AssistantMessage, initial?: Usage): boolean {
  return initial !== undefined && message.usage !== initial || message.usage.totalTokens > 0;
}

export async function recordModelUsage(request: Request | undefined, callId: string, purpose: string, message: AssistantMessage, initial?: Usage) {
  await request?.log.append({ type: "model_usage", requestId: request.id, callId, purpose,
    provider: message.provider, model: message.model, usageAvailable: hasProviderUsage(message, initial), usage: message.usage,
    stopReason: message.stopReason, providerTimestamp: message.timestamp });
}
