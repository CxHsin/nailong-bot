import type { AssistantMessage, ImageContent, Message, ToolCall } from "@mariozechner/pi-ai";
import type { StoredEvent } from "./runtime-types.js";
import type { HistoryScope } from "./history-scope.js";
import { factOwnerId } from "./facts.js";
import { effectiveInput, eventIdentity } from "./memory-facts.js";
import { userInputText } from "./reply-context.js";
import { segmentDelivery } from "./delivery-facts.js";

type UnitFact = { event: StoredEvent; through: number; requestId?: string; safe: boolean; sourceIds?: string[]; protected?: boolean };
export type HistoryPair = { call: ToolCall; identity: string } &
  ({ outcome: "result"; result: StoredEvent; dispatch: StoredEvent } | { outcome: "unknown" });
export type HistoryFact = UnitFact & (
  | { kind: "input"; text: string; images: ImageContent[]; supplemental: Message[]; current: boolean }
  | { kind: "terminal"; owner: string }
  | { kind: "recorded"; messages: Message[] }
  | { kind: "skill" }
  | { kind: "feedback"; text: string }
  | { kind: "text"; contentKind: "progress" | "status" | "result" | "final"; text: string;
      original?: AssistantMessage; settled?: StoredEvent; unconfirmed?: boolean; auxiliary?: boolean }
  | { kind: "model"; original: AssistantMessage; pairs: HistoryPair[]; progresses: StoredEvent[];
      progressStep: boolean; resultDelivered: boolean; activeCurrent: boolean }
);
export type HistoryVisit = { kind: "pause"; phase: "index" | "replay"; index: number } | { kind: "fact"; fact: HistoryFact };

/** Pure admission/identity/pairing over committed facts. Visits let callers yield without importing I/O here. */
export function* interpretHistory(scope: HistoryScope, currentId: string, structured: boolean, start = 0): Generator<HistoryVisit, string[]> {
  const { all, events, selected, excluded, host } = scope;
  const resultDelivered = (id: unknown) => segmentDelivery(events, id).complete;
  const results = new Map<string, { event: StoredEvent; index: number }>();
  const dispatch = new Map<string, { event: StoredEvent; index: number }>();
  const delivered = new Set(events.filter((event) => event.type === "delivery_succeeded").map((event) => event.requestId));
  const ended = new Set(events.filter((event) => ["request_failed", "request_completed", "request_interrupted", "run_succeeded", "run_failed", "run_cancelled"].includes(event.type))
    .map((event) => event.requestId ?? event.runId));
  const discarded = new Set(events.filter((event) => event.type === "text_discarded").map((event) => event.textSegmentId));
  const progressSteps = new Set(events.filter((event) => event.type === "text_finalized" &&
    ["progress", "status", "result"].includes(String(event.contentKind)) && typeof event.modelStepId === "string").map((event) => event.modelStepId));
  const diagnostics: string[] = [];
  const used = new Set<string>();
  const calls = new Set<string>();
  const key = (event: StoredEvent) => `${event.requestId}:${String(event.toolCallId)}`;
  const sourceId = (event: StoredEvent) => eventIdentity(event, all.indexOf(event));
  const hasTools = (step: unknown) => events.some((event) => event.type === "model_message" && event.modelStepId === step &&
    (event.message as AssistantMessage)?.content?.some((part) => part.type === "toolCall"));
  const recordedMessages = (event: StoredEvent): Message[] => {
    const messages = Array.isArray(event.messages) ? event.messages as Message[] : [];
    const excludedQuotes = Array.isArray(event.memoryNodeIds) && event.memoryNodeIds.some((id) => excluded.has(String(id)));
    return excludedQuotes ? messages.filter((message) => typeof message.content === "string" && !message.content.startsWith("长期记忆原文引用")) : messages;
  };
  const textFact = (unit: UnitFact, contentKind: "progress" | "status" | "result" | "final", text: string, settled?: StoredEvent,
    extra: { unconfirmed?: boolean; auxiliary?: boolean } = {}): HistoryFact => ({ ...unit, kind: "text", contentKind, text, settled,
      original: settled?.modelStepId ? all.find((event) => event.type === "model_message" &&
        event.requestId === settled.requestId && event.modelStepId === settled.modelStepId)?.message as AssistantMessage | undefined : undefined, ...extra });

  // Index the entire selected source, including results after the suffix's start.
  for (const [index, event] of events.entries()) {
    if (index % 32 === 0) yield { kind: "pause", phase: "index", index };
    if (event.type === "text_finalized" && discarded.has(event.textSegmentId)) continue;
    if (!selected.has(event.requestId ?? "")) continue;
    if (event.type === "tool_result") {
      if (results.has(key(event))) throw new Error("工具结果编号重复");
      results.set(key(event), { event, index });
    }
    if (event.type === "tool_dispatch" || event.type === "tool_blocked") dispatch.set(key(event), { event, index });
  }

  let legacyRequest: string | undefined;
  for (const [index, event] of events.entries()) {
    if (event.type === "message" && event.role === "user") legacyRequest = scope.ownerOfUser(event, index);
    if (index < start) continue;
    if (index % 32 === 0) yield { kind: "pause", phase: "replay", index };
    if (event.type === "text_finalized" && discarded.has(event.textSegmentId)) continue;
    if (!effectiveInput(event, events, currentId)) continue;
    const owner = factOwnerId(event) ?? legacyRequest;
    if (!owner || !selected.has(owner)) continue;
    const unit: UnitFact = { event, through: index + 1, requestId: event.requestId, safe: true };
    let fact: HistoryFact | undefined;
    if (event.type === "message" && event.role === "user" && typeof event.text === "string") {
      const snapshots = event.inputKind === "steer" ? [] : events.filter((entry) => entry.type === "context_input_snapshot" && entry.requestId === event.requestId);
      fact = { ...unit, kind: "input", text: userInputText(event, excluded), images: Array.isArray(event.images) ? event.images as ImageContent[] : [],
        supplemental: snapshots.flatMap(recordedMessages), current: event.requestId === currentId && event.inputKind !== "steer",
        through: Math.max(index + 1, ...snapshots.map((snapshot) => events.indexOf(snapshot) + 1)), requestId: legacyRequest, sourceIds: [sourceId(event)] };
    } else if (["run_cancelled", "run_failed"].includes(event.type)) {
      fact = { ...unit, kind: "terminal", owner, requestId: owner, protected: true };
    } else if (event.type === "context_input_updated" && Array.isArray(event.messages)) {
      const messages = recordedMessages(event);
      if (messages.length) fact = { ...unit, kind: "recorded", messages, requestId: owner };
    } else if (event.type === "skill_loaded" && event.mode === "explicit" && typeof event.body === "string") {
      fact = { ...unit, kind: "skill", safe: event.requestId !== currentId };
    } else if (event.type === "message" && event.role === "assistant" && !event.requestId && typeof event.text === "string") {
      fact = textFact({ ...unit, requestId: legacyRequest, sourceIds: [sourceId(event)] }, "final", event.text);
    } else if (structured && event.type === "protocol_feedback" && event.requestId === currentId && typeof event.text === "string" &&
      !events.slice(index + 1).some((next) => next.type === "protocol_feedback_superseded" && next.requestId === currentId)) {
      fact = { ...unit, kind: "feedback", text: event.text };
    } else if (event.type === "model_message") {
      const original = event.message as AssistantMessage;
      if (event.protocolVersion && event.protocolVersion !== "plain-text-v3" && !events.some((entry) => entry.type === "protocol_validated" &&
        entry.modelStepId === event.modelStepId && entry.valid === true)) continue;
      if (original?.role !== "assistant" || !Array.isArray(original.content) || original.stopReason === "error" || original.stopReason === "aborted") continue;
      const toolCalls = original.content.filter((part): part is ToolCall => part.type === "toolCall");
      const pairs: HistoryPair[] = [];
      let through = index + 1;
      let safe = true;
      for (const call of toolCalls) {
        const identity = `${event.requestId}:${call.id}`;
        if (calls.has(identity)) throw new Error("工具调用编号重复");
        calls.add(identity);
        const found = results.get(identity);
        const sent = dispatch.get(identity);
        if (found && sent?.event.toolName === call.name && sent.index > index && found.index > sent.index && found.event.toolName === call.name) {
          pairs.push({ outcome: "result", identity, call, result: found.event, dispatch: sent.event });
          used.add(identity);
          through = Math.max(through, found.index + 1);
        } else if (!found && sent?.event.toolName === call.name && sent.index > index && event.requestId !== currentId && ended.has(event.requestId)) {
          pairs.push({ outcome: "unknown", identity, call });
          safe = false;
          diagnostics.push(`outcome_unknown:${identity}`);
        } else diagnostics.push(`unmatched_tool_call:${identity}`);
      }
      const progresses = events.filter((entry) => entry.type === "text_finalized" && entry.modelStepId === event.modelStepId &&
        !discarded.has(entry.textSegmentId) && ["progress", "status", "result"].includes(String(entry.contentKind)));
      const progress = progresses[0];
      if (!toolCalls.length || pairs.length) fact = { ...unit, kind: "model", original, pairs, progresses, through, safe,
        progressStep: progressSteps.has(event.modelStepId), resultDelivered: resultDelivered(progress?.textSegmentId),
        activeCurrent: event.requestId === currentId && !ended.has(currentId),
        ...(pairs.length ? { sourceIds: progress?.contentKind === "result" && resultDelivered(progress.textSegmentId) ? [sourceId(progress)] : [] } : {}) };
    } else if (event.type === "text_finalized" && ["progress", "status", "result"].includes(String(event.contentKind)) &&
      typeof event.textSegmentId === "string" && typeof event.text === "string" && event.requestId) {
      if ((event.protocolVersion === "plain-text-v3" || event.contextPolicy === "include") && hasTools(event.modelStepId)) continue;
      if (host && event.contentKind !== "result" && event.protocolVersion !== "plain-text-v3" && event.contextPolicy !== "include") continue;
      if (!host && event.contentKind === "result" && !resultDelivered(event.textSegmentId)) {
        if (event.requestId !== currentId || ended.has(currentId)) continue;
        if (!hasTools(event.modelStepId)) fact = textFact(unit, "status", event.text, undefined, { unconfirmed: true });
      } else if (!structured || !hasTools(event.modelStepId)) {
        fact = textFact({ ...unit, sourceIds: event.contentKind === "result" ? [sourceId(event)] : [] },
          event.contentKind as "progress" | "status" | "result", event.text, event, { auxiliary: event.source === "progress-model" });
      }
    } else if (event.type === "delivery_succeeded" && event.requestId && delivered.has(event.requestId) &&
      (!host || !events.some((entry) => entry.type === "run_succeeded" && entry.runId === event.requestId)) ||
      host && event.type === "run_succeeded" && (event.result as { kind?: string } | undefined)?.kind === "model") {
      const requestId = event.requestId ?? event.runId;
      const answer = events.slice(0, index).findLast((entry) => entry.type === "answer_generated" && entry.requestId === requestId);
      if (typeof answer?.text === "string") {
        const finalized = events.findLast((entry) => entry.type === "text_finalized" && entry.requestId === requestId && entry.contentKind === "final" && entry.text === answer.text);
        fact = textFact({ ...unit, requestId: typeof requestId === "string" ? requestId : undefined, sourceIds: [sourceId(finalized ?? answer)] }, "final", answer.text, finalized);
      }
    }
    if (fact) yield { kind: "fact", fact };
  }
  for (const [identity, found] of results) if (selected.has(found.event.requestId ?? "") && found.index >= start && !used.has(identity)) diagnostics.push(`unmatched_tool_result:${identity}`);
  return diagnostics;
}
