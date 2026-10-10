import { assistantText } from "../agent/model-message.js";
import { segmentDelivery } from "../runtime/delivery-facts.js";
import { sourceDigest } from "../runtime/event-digest.js";
import { factOwnerId } from "../runtime/facts.js";
import type { Api, AssistantMessage, ImageContent, Message, Model, ToolCall } from "@mariozechner/pi-ai";
import { type RuntimeLog, type StoredEvent, type ToolArchive,
  type ToolResult } from "../runtime/runtime-types.js";
import { protocolText } from "../agent/output-protocol.js";
import { replayToolResultView } from "./tool-result-projection.js";
import { effectiveInput, eventIdentity, memoryExclusions } from "../runtime/memory-facts.js";
import { filterMemoryEvents, filterMemoryToolResult, filterArchivedMemoryResult } from "../runtime/memory-exclusion.js";
import { userInputText } from "../runtime/reply-context.js";
import { replayableReasoning } from "./provider-aware.js";
import { prepareActiveContext, activeContextStart, activeRequestIds } from "./active-context.js";

export type ReplayUnit = { messages: Message[]; summaryMessages?: Message[];
  through: number; requestId?: string; safe: boolean; sourceIds?: string[]; protected?: boolean };
export type Replay = { events: StoredEvent[]; boundary: string; units: ReplayUnit[]; current: Message;
  diagnostics: string[]; processedEvents?: number };

export async function replayEvents(log: RuntimeLog, currentId: string, model: Model<Api>, structured = false, onProgress?: (checked: number, total: number) => void, signal?: AbortSignal, seed?: { replay: Replay; start: number }, legacy?: { requestIds: string[]; boundary: string }): Promise<Replay> {
  const prepared = await prepareActiveContext(log, currentId, legacy);
  const rawEvents = prepared.raw;
  const hostConversationReplay = rawEvents.some((event) => event.requestId === currentId && typeof event.conversationId === "string");
  const excluded = memoryExclusions(rawEvents);
  const all = filterMemoryEvents(rawEvents);
  const replayText = (type: "progress" | "status" | "result" | "final", text: string, timestamp: number, settled?: StoredEvent) => {
    const message = assistantText(structured ? protocolText(type, text) : text, model, timestamp);
    const original = settled?.modelStepId ? all.find((event) => event.type === "model_message" && event.requestId === settled.requestId && event.modelStepId === settled.modelStepId)?.message as AssistantMessage | undefined : undefined;
    if (!structured && original?.api === model.api && original.provider === model.provider && original.model === model.id) {
      const part = typeof settled?.modelTextIndex === "number" ? original.content[settled.modelTextIndex] : original.content.find((part) => part.type === "text" && part.text === text);
      if (part?.type === "text" && part.text === text && part.textSignature) message.content = [{ ...part }];
    }
    return message;
  };
  const reset = all.findLastIndex((event) => event.type === "reset" || event.type === "conversation_reset");
  let events = all.slice(reset + 1);
  const active = activeContextStart(rawEvents) ?? (prepared.pending ? { ...prepared.pending, at: "" } : undefined);
  // A turn is one user input and its model/tool messages, not a model step.
  // Select before recovering archives so unrelated old results cannot block replay.
  const turnIds = events.flatMap((event, index) => event.type === "message" && event.role === "user"
    ? [event.requestId ?? (active ? `legacy:${eventIdentity(event, all.indexOf(event))}` : `legacy:${index}`)] : []);
  const recent = [...new Set(turnIds.filter((id) => id !== currentId))].slice(-3);
  const selected = active ? activeRequestIds(rawEvents, active) : new Set([...recent, currentId]);
  const resultDelivered = (segmentId: unknown) => segmentDelivery(events, segmentId).complete;
  const units: ReplayUnit[] = seed ? structuredClone(seed.replay.units.filter((unit) => selected.has(unit.requestId ?? "") && unit.through <= seed.start && !(unit.summaryMessages?.length === 0 && unit.requestId !== currentId))) : [];
  const affectedIds = new Set(events.slice(seed?.start ?? 0).map((event) => event.requestId ?? event.runId).filter((id): id is string => typeof id === "string"));
  const diagnostics: string[] = seed ? seed.replay.diagnostics.filter((item) => !item.startsWith("unmatched_tool_") &&
    (!item.startsWith("outcome_unknown:") || [...selected].some((id) => item.startsWith(`outcome_unknown:${id}:`))) &&
    ![...affectedIds].some((id) => item.startsWith(`outcome_unknown:${id}:`))) : [];
  const key = (e: StoredEvent) => `${e.requestId}:${String(e.toolCallId)}`;
  const results = new Map<string, { event: StoredEvent; index: number }>();
  const dispatch = new Map<string, { event: StoredEvent; index: number }>();
  const delivered = new Set(events.filter((e) => e.type === "delivery_succeeded").map((e) => e.requestId));
  const ended = new Set(events.filter((e) => ["request_failed", "request_completed", "request_interrupted", "run_succeeded", "run_failed", "run_cancelled"].includes(e.type))
    .map((e) => e.requestId ?? e.runId));
  const used = new Set<string>();
  const calls = new Set<string>();
  const progressSteps = new Set(events.filter((event) => event.type === "text_finalized" &&
    ["progress", "status", "result"].includes(String(event.contentKind)) && typeof event.modelStepId === "string")
    .map((event) => event.modelStepId));
  const discarded = new Set(events.filter((event) => event.type === "text_discarded").map((event) => event.textSegmentId));
  for (const [index, event] of events.entries()) {
    if (index % 32 === 0) { if (signal?.aborted) throw new DOMException("历史恢复已取消", "AbortError"); await new Promise<void>((resolve) => setImmediate(resolve)); }
    if (event.type === "text_finalized" && discarded.has(event.textSegmentId)) continue;
    if (!selected.has(event.requestId ?? "")) continue;
    if (event.type === "tool_result") {
      if (results.has(key(event))) throw new Error("工具结果编号重复");
      results.set(key(event), { event, index });
    }
    if ((event.type === "tool_dispatch" || event.type === "tool_blocked")) dispatch.set(key(event), { event, index });
  }
  let current: Message | undefined;
  let legacyRequest: string | undefined;
  for (const [index, event] of events.entries()) {
    if (event.type === "message" && event.role === "user") legacyRequest = event.requestId ?? (active ? `legacy:${eventIdentity(event, all.indexOf(event))}` : `legacy:${index}`);
    if (index < (seed?.start ?? 0)) continue;
    if (index % 32 === 0) { if (signal?.aborted) throw new DOMException("历史恢复已取消", "AbortError"); onProgress?.(index - (seed?.start ?? 0), events.length - (seed?.start ?? 0)); await new Promise<void>((resolve) => setImmediate(resolve)); }
    if (event.type === "text_finalized" && discarded.has(event.textSegmentId)) continue;
    if (!effectiveInput(event, events, currentId)) continue;
    const owner = factOwnerId(event) ?? legacyRequest;
    if (!owner || !selected.has(owner)) continue;
    const timestamp = Date.parse(event.at) || 0;
    if (event.type === "message" && event.role === "user" && typeof event.text === "string") {
      const images = Array.isArray(event.images) ? event.images as ImageContent[] : [];
      const text = userInputText(event, excluded);
      const message: Message = { role: "user", content: images.length
        ? [{ type: "text", text }, ...images] : text, timestamp };
      if (event.requestId === currentId && event.inputKind !== "steer") current = message;
      legacyRequest = event.requestId ?? (active ? `legacy:${eventIdentity(event, all.indexOf(event))}` : `legacy:${index}`);
      const snapshots = event.inputKind === "steer" ? [] : events.filter((entry) => entry.type === "context_input_snapshot" && entry.requestId === event.requestId);
      const supplemental = snapshots.flatMap((snapshot) => {
        const messages = Array.isArray(snapshot.messages) ? snapshot.messages as Message[] : [];
        const excludedQuotes = Array.isArray(snapshot.memoryNodeIds) && snapshot.memoryNodeIds.some((id) => excluded.has(String(id)));
        return excludedQuotes ? messages.filter((message) => typeof message.content === "string" && !message.content.startsWith("长期记忆原文引用")) : messages;
      });
      units.push({ messages: [...supplemental, message], through: Math.max(index + 1, ...snapshots.map((snapshot) => events.indexOf(snapshot) + 1)), requestId: legacyRequest, safe: true,
        sourceIds: [eventIdentity(event, all.indexOf(event))] });
    } else if (["run_cancelled", "run_failed"].includes(event.type)) {
      units.push({ messages: [{ role: "user", timestamp, content: `运行层状态记录：Run ${owner} 已${event.type === "run_cancelled" ? "停止" : "失败"}。已完成的操作保留；不要自动续做已停止的任务或执行已取消的待处理输入，后续工作以新的用户输入为准。` }],
        through: index + 1, requestId: owner, safe: true, protected: true });
    } else if (event.type === "context_input_updated" && Array.isArray(event.messages)) {
      const excludedQuotes = Array.isArray(event.memoryNodeIds) && event.memoryNodeIds.some((id) => excluded.has(String(id)));
      const messages = (event.messages as Message[]).filter((message) => !excludedQuotes ||
        typeof message.content === "string" && !message.content.startsWith("长期记忆原文引用"));
      if (messages.length) units.push({ messages, through: index + 1, requestId: owner, safe: true });
    } else if (event.type === "skill_loaded" && event.mode === "explicit" && typeof event.body === "string") {
      units.push({ messages: [{ role: "user", timestamp, content: `运行层按用户显式引用加载的 skill 指令（${String(event.source)}:${String(event.name)}；根目录 ${String(event.root)}；版本 ${String(event.digest)}）：\n${event.body}` }],
        through: index + 1, requestId: event.requestId, safe: event.requestId !== currentId });
    } else if (event.type === "message" && event.role === "assistant" && !event.requestId && typeof event.text === "string") {
      units.push({ messages: [replayText("final", event.text, timestamp)], through: index + 1,
        requestId: legacyRequest, safe: true, sourceIds: [eventIdentity(event, all.indexOf(event))] });
    } else if (structured && event.type === "protocol_feedback" && event.requestId === currentId && typeof event.text === "string" &&
      !events.slice(index + 1).some((next) => next.type === "protocol_feedback_superseded" && next.requestId === currentId)) {
      units.push({ messages: [{ role: "user", content: event.text, timestamp }], through: index + 1,
        requestId: event.requestId, safe: true, summaryMessages: [] });
    } else if (event.type === "model_message") {
      const original = event.message as AssistantMessage;
      if (event.protocolVersion && event.protocolVersion !== "plain-text-v3" && !events.some((e) => e.type === "protocol_validated" &&
        e.modelStepId === event.modelStepId && e.valid === true)) continue;
      if (original?.role !== "assistant" || !Array.isArray(original.content) ||
        original.stopReason === "error" || original.stopReason === "aborted") continue;
      const toolCalls = original.content.filter((c): c is ToolCall => c.type === "toolCall");
      if (!toolCalls.length) {
        const reasoning = replayableReasoning(original, model);
        if (hostConversationReplay && reasoning.length) units.push({ messages: [{ ...original, content: reasoning }],
          through: index + 1, requestId: event.requestId, safe: true });
        continue; // Final text is admitted by settlement/delivery, not raw generation.
      }
      const kept: ToolCall[] = [];
      const responses: Message[] = [];
      const summaryResponses: Message[] = [];
      let through = index + 1;
      let safe = true;
      for (const call of toolCalls) {
        const identity = `${event.requestId}:${call.id}`;
        if (calls.has(identity)) throw new Error("工具调用编号重复");
        calls.add(identity);
        const found = results.get(identity);
        const sent = dispatch.get(identity);
        if (found && sent?.event.toolName === call.name && sent.index > index &&
          found.index > sent.index &&
          found.event.toolName === call.name) {
          const archive = found.event.archive as ToolArchive | undefined;
          let result: ToolResult;
          try { result = archive ? await log.recoverArchive(archive, found.event.result as ToolResult | undefined) :
            found.event.result as ToolResult; }
          catch { throw new Error("工具归档缺失或校验失败"); }
          if (!result || !Array.isArray(result.content)) throw new Error("缺少完整工具结果");
          const unfiltered = result;
          result = filterArchivedMemoryResult(rawEvents, found.event, filterMemoryToolResult(call.name, result, excluded), excluded);
          const view = replayToolResultView({ result, archive,
            projectionVersion: found.event.modelProjectionVersion,
            modelProjection: found.event.modelProjection, sourceResult: unfiltered,
            sourceFiltered: result !== unfiltered, recorded: found.event.modelVisible,
            archiveRead: log.isArchiveRead(call.name, sent.event.args),
            olderThanRecent: false,
            toolName: call.name });
          kept.push(call);
          responses.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: view.content,
            details: view.details, isError: result.isError, timestamp: Date.parse(found.event.at) || 0 });
          summaryResponses.push({ role: "toolResult", toolCallId: call.id, toolName: call.name,
            content: structuredClone(result.content), details: result.details, isError: result.isError,
            timestamp: Date.parse(found.event.at) || 0 });
          used.add(identity);
          through = Math.max(through, found.index + 1);
        } else if (!found && sent?.event.toolName === call.name && sent.index > index &&
          event.requestId !== currentId &&
          ended.has(event.requestId)) {
          kept.push(call);
          responses.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true,
            content: [{ type: "text", text: `outcome_unknown:${identity}: 工具已派发，但没有持久结果；可能已产生副作用。先检查现状，不要盲目重试。` }], timestamp });
          summaryResponses.push(responses.at(-1)!);
          safe = false;
          diagnostics.push(`outcome_unknown:${identity}`);
        } else diagnostics.push(`unmatched_tool_call:${identity}`);
      }
      if (kept.length) {
        const progresses = events.filter((e) => e.type === "text_finalized" && e.modelStepId === event.modelStepId &&
          !discarded.has(e.textSegmentId) &&
          ["progress", "status", "result"].includes(String(e.contentKind)));
        const progress = progresses[0];
        const assistant = { ...original, content: original.content.filter((c) =>
          c.type === "toolCall" ? kept.includes(c) : c.type === "thinking" ? !hostConversationReplay : c.type !== "text" || (!structured && !progressSteps.has(event.modelStepId))) };
        if (hostConversationReplay) assistant.content.unshift(...replayableReasoning(original, model));
        if (event.protocolVersion === "plain-text-v3") {
          assistant.content = original.content.filter((part, index) => {
            if (part.type === "toolCall") return kept.includes(part);
            if (part.type === "thinking") return false;
            return progresses.some((settled) => typeof settled.modelTextIndex === "number" ? settled.modelTextIndex === index && settled.text === part.text : settled.text === part.text);
          });
          if (hostConversationReplay) assistant.content.unshift(...replayableReasoning(original, model));
        } else if (progress?.contextPolicy === "include" && progress && typeof progress.text === "string") {
          assistant.content = assistant.content.filter((part) => part.type !== "text");
          assistant.content.push({ type: "text", text: progress.text });
        }
        if (progress?.contentKind === "result") {
          // Keep execution facts regardless of UI delivery, but never imply unseen text was delivered.
          assistant.content = assistant.content.filter((part) => part.type !== "text");
          const text = String(progress.text);
          if (hostConversationReplay || resultDelivered(progress.textSegmentId)) {
            assistant.content.push({ type: "text", text: structured ? protocolText("result", text) : text });
          } else if (event.requestId === currentId && !ended.has(currentId)) {
            const work = `内部工作成果（尚未确认送达用户）：\n${text}`;
            assistant.content.push({ type: "text", text: structured ? protocolText("status", work) : work });
          }
        } else if (structured && (progress || !event.protocolVersion) && !hostConversationReplay) {
          const text = typeof progress?.text === "string" ? progress.text : original.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
          if (text) assistant.content.push({ type: "text", text: protocolText(progress?.contentKind === "status" ? "status" : "progress", text) });
        }
        units.push({ messages: [assistant, ...responses], summaryMessages: [assistant, ...summaryResponses],
          through, requestId: event.requestId, safe, sourceIds: progress?.contentKind === "result" && resultDelivered(progress.textSegmentId)
            ? [eventIdentity(progress, all.indexOf(progress))] : [] });
      }
    } else if (event.type === "text_finalized" && ["progress", "status", "result"].includes(String(event.contentKind)) &&
      typeof event.textSegmentId === "string" && typeof event.text === "string" && event.requestId) {
      if ((event.protocolVersion === "plain-text-v3" || event.contextPolicy === "include") && events.some((e) => e.type === "model_message" &&
        e.modelStepId === event.modelStepId && (e.message as AssistantMessage)?.content?.some((c) => c.type === "toolCall"))) continue;
      if (hostConversationReplay && event.contentKind !== "result" && event.protocolVersion !== "plain-text-v3" && event.contextPolicy !== "include") continue;
      if (!hostConversationReplay && event.contentKind === "result" && !resultDelivered(event.textSegmentId)) {
        if (event.requestId !== currentId || ended.has(currentId)) continue;
        const work = `内部工作成果（尚未确认送达用户）：\n${event.text}`;
        if (!events.some((e) => e.type === "model_message" && e.modelStepId === event.modelStepId &&
          (e.message as AssistantMessage)?.content?.some((c) => c.type === "toolCall"))) {
          units.push({ messages: [replayText("status", work, timestamp)], through: index + 1,
            requestId: event.requestId, safe: true });
        }
        continue;
      }
      if (structured && events.some((e) => e.type === "model_message" && e.modelStepId === event.modelStepId &&
        (e.message as AssistantMessage)?.content?.some((c) => c.type === "toolCall"))) continue;
      const text = event.source === "progress-model" ? `运行摘要（来源：独立进展模型，仅依据已记录事实）：\n${event.text}` : event.text;
      units.push({ messages: [replayText(event.contentKind as "progress" | "status" | "result", text, timestamp, event)], through: index + 1,
        requestId: event.requestId, safe: true, sourceIds: event.contentKind === "result" ? [eventIdentity(event, all.indexOf(event))] : [] });
    } else if (event.type === "delivery_succeeded" && event.requestId && delivered.has(event.requestId) &&
      (!hostConversationReplay || !events.some((e) => e.type === "run_succeeded" && e.runId === event.requestId)) ||
      hostConversationReplay && event.type === "run_succeeded" && (event.result as { kind?: string } | undefined)?.kind === "model") {
      const requestId = event.requestId ?? event.runId;
      const answer = events.slice(0, index).findLast((e) => e.type === "answer_generated" && e.requestId === requestId);
      if (typeof answer?.text === "string") {
        const finalized = events.findLast((e) => e.type === "text_finalized" && e.requestId === requestId && e.contentKind === "final" && e.text === answer.text);
        const source = finalized ?? answer;
        units.push({ messages: [replayText("final", answer.text, timestamp, finalized)], through: index + 1, requestId: typeof requestId === "string" ? requestId : undefined,
          safe: true, sourceIds: [eventIdentity(source, all.indexOf(source))] });
      }
    }
  }
  for (const [identity, found] of results) if (selected.has(found.event.requestId ?? "") && found.index >= (seed?.start ?? 0) && !used.has(identity)) diagnostics.push(`unmatched_tool_result:${identity}`);
  if (!current) throw new Error("缺少当前用户消息");
  if (prepared.pending) {
    if (signal?.aborted) throw new DOMException("历史恢复已取消", "AbortError");
    await log.append(prepared.pending);
    // Commit the one-time boundary only after original facts were replayed
    // successfully. A missing archive must not masquerade as a migration.
    const committed = filterMemoryEvents(await log.read());
    const committedReset = committed.findLastIndex((event) => ["reset", "conversation_reset"].includes(event.type));
    events = committed.slice(committedReset + 1);
  }
  // Older checkpoints may contain cross-Run feedback. Keep raw events, but never
  // reuse summaries created under the previous projection policy.
  const boundary = active ? `active-v1:${active.activeContextId}` : `${reset < 0 ? "initial" : sourceDigest(all.slice(0, reset + 1))}:recent-three-v1:${sourceDigest(recent)}`;
  return { events, boundary: excluded.size ? `${boundary}:${sourceDigest([...excluded].sort())}` : boundary, units, current, diagnostics, processedEvents: events.length - (seed?.start ?? 0) };
}
