import { appendRuntimeFact } from "../../src/runtime/facts.js";
import type { RuntimeLog } from "../../src/runtime/runtime-types.js";

/** Compiled by the existing typecheck; these are never executed as runtime tests. */
export function productionFactTypes(log: RuntimeLog) {
  appendRuntimeFact(log, { type: "tool_dispatch", requestId: "request", toolCallId: "call", toolName: "read", args: {} });
  appendRuntimeFact(log, { type: "run_succeeded", runId: "run", conversationId: "conversation", result: { resultId: "result", text: "answer" } });
  // @ts-expect-error A reusable successful result must carry its own durable identity.
  appendRuntimeFact(log, { type: "run_succeeded", runId: "run", conversationId: "conversation", result: { text: "answer" } });
  appendRuntimeFact(log, { type: "telegram_delivery_succeeded", requestId: "run", textSegmentId: "segment", partIndex: 0,
    target: 42, attemptId: "attempt", telegramMessageId: 123 });
  // @ts-expect-error A terminal Run must identify its Conversation.
  appendRuntimeFact(log, { type: "run_succeeded", runId: "run", result: { text: "answer" } });
  // @ts-expect-error Run success requires the settled result.
  appendRuntimeFact(log, { type: "run_succeeded", runId: "run", conversationId: "conversation" });
  // @ts-expect-error A model call needs its call identity, not a tool identity.
  appendRuntimeFact(log, { type: "model_call_started", requestId: "run", toolCallId: "call", purpose: "execution", provider: "test", model: "test" });
  // @ts-expect-error A successful Channel delivery needs the returned message identity.
  appendRuntimeFact(log, { type: "telegram_delivery_succeeded", requestId: "run", textSegmentId: "segment", partIndex: 0, target: 42, attemptId: "attempt" });
  // @ts-expect-error Frozen capabilities must carry the catalog identity.
  appendRuntimeFact(log, { type: "capability_snapshot", requestId: "run", skillsDigest: "skills", mode: "compat", unavailableSources: [], tools: [] });
  // @ts-expect-error A model-visible input snapshot belongs to a request.
  appendRuntimeFact(log, { type: "context_input_snapshot", runId: "run", messages: [], shown: [], tokens: 0, memoryCoverage: [], memoryNodeIds: [] });
  // @ts-expect-error A Run identity does not substitute for the owning request identity.
  appendRuntimeFact(log, { type: "tool_dispatch", runId: "request", toolCallId: "call", toolName: "read" });
  // @ts-expect-error A tool result must carry the tool-call identity.
  appendRuntimeFact(log, { type: "tool_result", requestId: "request", toolName: "read", result: { content: [], details: undefined, isError: false } });
  // @ts-expect-error Unknown events use the raw compatibility log, never the production fact writer.
  appendRuntimeFact(log, { type: "future_event", requestId: "request" });
}
