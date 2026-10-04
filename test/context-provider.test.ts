import assert from "node:assert/strict";
import test from "node:test";
import { projectProviderContext, type ContextItem, type ProviderCapabilities } from "../src/context/provider-aware.js";

const caps = (changes: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  provider: "fake", model: "model-1", promptProfile: "default", reasoningReplay: true,
  promptCaching: true, images: true, compaction: true, appendConfigurationUpdates: true, ...changes,
});

function baseItems(): ContextItem[] {
  return [
    { type: "user", id: "u1", parts: [{ type: "text", text: "看图" }] },
    { type: "image", id: "i1", mimeType: "image/png", data: "cG5n" },
    { type: "reasoning", id: "r1", text: "visible summary", continuationMetadata: { token: "opaque" } },
    { type: "commentary", id: "c1", text: "draft", contextPolicy: "exclude" },
    { type: "delivery", id: "d1", status: "succeeded", contextPolicy: "exclude" },
    { type: "toolCall", id: "t1", name: "search", arguments: { q: "x" } },
    { type: "toolResult", id: "tr1", toolCallId: "t1", result: "answer" },
    { type: "assistant", id: "a1", parts: [{ type: "text", text: "done" }] },
  ];
}

test("Provider projection filters UI facts and encodes supported images and tools", () => {
  const result = projectProviderContext({ conversationId: "c1", capabilities: caps(), items: baseItems() });
  assert.deepEqual(result.items.map((item) => item.type), ["user", "image", "reasoning", "toolCall", "toolResult", "assistant"]);
  assert.ok(result.messages.some((message) => message.role === "user" && message.content?.some((part: { type?: string }) => part.type === "text")));
  assert.ok(result.messages.some((message) => message.role === "user" && message.content?.some((part: { type?: string }) => part.type === "image")));
});

test("reasoning requires replay metadata and cache identity is stable across ordinary turns", () => {
  const first = projectProviderContext({ conversationId: "c1", capabilities: caps(), items: baseItems() });
  const withoutReplay = projectProviderContext({ conversationId: "c1", capabilities: caps({ reasoningReplay: false }), items: baseItems() });
  assert.ok(first.items.some((item) => item.type === "reasoning"));
  assert.ok(!withoutReplay.items.some((item) => item.type === "reasoning"));
  const second = projectProviderContext({ conversationId: "c1", capabilities: caps(), items: [...baseItems(), { type: "user", id: "u2", parts: [{ type: "text", text: "继续" }] }] });
  assert.equal(first.cacheKey, second.cacheKey);
  assert.equal(first.stablePrefixKey, second.stablePrefixKey);
});

test("configuration updates append when supported and create a new segment otherwise", () => {
  const items: ContextItem[] = [...baseItems(), { type: "configUpdate", id: "cfg", changes: { temperature: 0.2 } }];
  const appended = projectProviderContext({ conversationId: "c1", capabilities: caps(), items });
  assert.ok(appended.messages.some((message) => message.role === "system" && JSON.stringify(message).includes("temperature")));
  const segmented = projectProviderContext({ conversationId: "c1", capabilities: caps({ appendConfigurationUpdates: false }), items });
  assert.notEqual(segmented.cacheKey, appended.cacheKey);
  assert.ok(segmented.segment > appended.segment);
});

test("compaction replaces the active prefix while retaining raw history", () => {
  const result = projectProviderContext({ conversationId: "c1", capabilities: caps(), items: baseItems(), compact: { through: 4, summary: "此前已完成搜索" } });
  assert.equal(result.rawItems.length, baseItems().length);
  assert.ok(result.items.some((item) => item.type === "compactionSummary"));
  assert.ok(result.messages.some((message) => JSON.stringify(message).includes("此前已完成搜索")));
});
