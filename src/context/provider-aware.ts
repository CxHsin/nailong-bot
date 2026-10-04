import { createHash } from "node:crypto";
import type { ContentPart } from "../host/content-parts.js";
import type { StoredEvent } from "../runtime/runtime-types.js";

export type ProviderCapabilities = {
  provider: string;
  model: string;
  promptProfile: string;
  reasoningReplay: boolean;
  promptCaching: boolean;
  images: boolean;
  compaction: boolean;
  appendConfigurationUpdates: boolean;
};
export type ContextItem =
  | { type: "user" | "assistant"; id: string; parts: ContentPart[] }
  | { type: "image"; id: string; mimeType: string; data?: string; contentRef?: string }
  | { type: "reasoning"; id: string; text?: string; signature?: string; encryptedContent?: string; continuationMetadata?: Record<string, unknown> }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "toolResult"; id: string; toolCallId: string; result: unknown; isError?: boolean }
  | { type: "compactionSummary"; id: string; summary: string; through: number }
  | { type: "configUpdate"; id: string; changes: Record<string, unknown> }
  | { type: "commentary" | "delivery" | "delta"; id: string; text?: string; status?: string; contextPolicy: "exclude" };

export type ProviderMessage = { role: "system" | "user" | "assistant" | "tool"; content: any; toolCallId?: string; name?: string };
export type ProviderProjectionRequest = { conversationId: string; capabilities: ProviderCapabilities; items: ContextItem[]; compact?: { through: number; summary: string } };
export type ProviderProjection = { cacheKey: string; stablePrefixKey: string; segment: number; items: ContextItem[]; rawItems: ContextItem[]; messages: ProviderMessage[] };

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hasReplayMetadata = (item: Extract<ContextItem, { type: "reasoning" }>) => Boolean(item.signature || item.encryptedContent || item.continuationMetadata);
const contextAllowed = (item: ContextItem) => !(["commentary", "delivery", "delta"].includes(item.type)) &&
  (!("contextPolicy" in item) || item.contextPolicy !== "exclude");

export function contextItemsFromEvents(events: StoredEvent[]): ContextItem[] {
  return events.flatMap((event, index): ContextItem[] => {
    const id = typeof event.eventId === "string" ? event.eventId : `${event.type}:${index + 1}`;
    if (event.type === "run_submitted" && Array.isArray(event.parts)) {
      return [{ type: "user", id, parts: event.parts as ContentPart[] }];
    }
    if (event.type === "message" && event.role === "user" && typeof event.text === "string") {
      const parts: ContentPart[] = [{ type: "text", text: event.text }];
      if (Array.isArray(event.images)) for (const image of event.images) if (image && typeof image === "object") {
        const candidate = image as { type?: unknown; mimeType?: unknown; data?: unknown };
        if (candidate.type === "image" && typeof candidate.mimeType === "string" && typeof candidate.data === "string") {
          parts.push({ type: "image", mimeType: candidate.mimeType, data: candidate.data });
        }
      }
      return [{ type: "user", id, parts }];
    }
    if (event.type === "text_finalized" && typeof event.text === "string" && event.contentKind === "final") {
      return [{ type: "assistant", id, parts: [{ type: "text", text: event.text }] }];
    }
    if (event.type === "tool_call" && typeof event.toolName === "string" && event.args && typeof event.args === "object") {
      return [{ type: "toolCall", id, name: event.toolName, arguments: event.args as Record<string, unknown> }];
    }
    if (event.type === "tool_result" && typeof event.toolCallId === "string") {
      return [{ type: "toolResult", id, toolCallId: event.toolCallId, result: event.result, isError: Boolean((event.result as { isError?: unknown })?.isError) }];
    }
    if (event.type === "progress_summary" && typeof event.text === "string") {
      return [{ type: "reasoning", id, text: event.text, ...(event.signature ? { signature: String(event.signature) } : {}),
        ...(event.encryptedContent ? { encryptedContent: String(event.encryptedContent) } : {}),
        ...(event.continuationMetadata && typeof event.continuationMetadata === "object" ? { continuationMetadata: event.continuationMetadata as Record<string, unknown> } : {}) }];
    }
    return [];
  });
}

export function projectProviderContext(request: ProviderProjectionRequest): ProviderProjection {
  const rawItems = request.items.map((item) => structuredClone(item));
  let items = request.items.filter(contextAllowed).map((item) => structuredClone(item));
  let segment = 0;
  if (request.compact) {
    if (!request.capabilities.compaction) throw new Error("Provider 不支持 compaction");
    const summary: ContextItem = { type: "compactionSummary", id: `compaction:${request.compact.through}`, through: request.compact.through, summary: request.compact.summary };
    items = [summary, ...items.slice(request.compact.through)];
  }
  items = items.filter((item) => item.type !== "reasoning" || (request.capabilities.reasoningReplay && hasReplayMetadata(item)));
  const hasImage = items.some((item) => item.type === "image" || (item.type === "user" || item.type === "assistant") && item.parts.some((part) => part.type === "image"));
  if (hasImage && !request.capabilities.images) throw new Error("Provider 不支持 image ContentPart");
  const config = items.filter((item) => item.type === "configUpdate");
  if (config.length && !request.capabilities.appendConfigurationUpdates) segment = config.length;
  const identity = { conversationId: request.conversationId, provider: request.capabilities.provider, model: request.capabilities.model,
    promptProfile: request.capabilities.promptProfile, segment: request.capabilities.promptCaching ? segment : Date.now() };
  const cacheKey = hash(identity);
  const stableItems = items.filter((item) => item.type !== "user" && item.type !== "assistant" && item.type !== "configUpdate");
  const stablePrefixKey = hash({ cacheKey, items: stableItems });
  const messages: ProviderMessage[] = [];
  for (const item of items) {
    if (item.type === "user" || item.type === "assistant") messages.push({ role: item.type, content: item.parts });
    else if (item.type === "image") messages.push({ role: "user", content: [{ type: "image", mimeType: item.mimeType, ...(item.data ? { data: item.data } : {}), ...(item.contentRef ? { contentRef: item.contentRef } : {}) }] });
    else if (item.type === "reasoning") messages.push({ role: "assistant", content: [{ type: "reasoning", text: item.text, signature: item.signature, encryptedContent: item.encryptedContent, continuationMetadata: item.continuationMetadata }] });
    else if (item.type === "toolCall") messages.push({ role: "assistant", content: [{ type: "toolCall", id: item.id, name: item.name, arguments: item.arguments }] });
    else if (item.type === "toolResult") messages.push({ role: "tool", toolCallId: item.toolCallId, content: item.result });
    else if (item.type === "compactionSummary") messages.push({ role: "system", content: `Compaction summary (through ${item.through}): ${item.summary}` });
    else if (item.type === "configUpdate") messages.push({ role: "system", content: { type: "configuration_update", changes: item.changes } });
  }
  return { cacheKey, stablePrefixKey, segment, items, rawItems, messages };
}

export const createProviderContextProjection = projectProviderContext;
