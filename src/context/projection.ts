import { assistantText } from "../agent/model-message.js";
import { segmentDelivery } from "../runtime/delivery-facts.js";
import { sourceDigest } from "../runtime/event-digest.js";
import type { Api, AssistantMessage, ImageContent, Message, Model, ToolCall } from "@mariozechner/pi-ai";
import { type RuntimeLog, type StoredEvent, type ToolArchive,
  type ToolResult } from "../runtime/runtime-types.js";
import { protocolText } from "../agent/output-protocol.js";
import { replayToolResultView } from "./tool-result-projection.js";

export type ReplayUnit = { messages: Message[]; summaryMessages?: Message[];
  through: number; requestId?: string; safe: boolean };
export type Replay = { events: StoredEvent[]; boundary: string; units: ReplayUnit[]; current: Message;
  diagnostics: string[] };

export async function replayEvents(log: RuntimeLog, currentId: string, model: Model<Api>, structured = false): Promise<Replay> {
  const all = await log.read();
  const replayText = (type: "progress" | "status" | "result" | "final", text: string, timestamp: number) =>
    assistantText(structured ? protocolText(type, text) : text, model, timestamp);
  const reset = all.findLastIndex((event) => event.type === "reset");
  const events = all.slice(reset + 1);
  const resultDelivered = (segmentId: unknown) => segmentDelivery(events, segmentId).complete;
  const units: ReplayUnit[] = [];
  const diagnostics: string[] = [];
  const key = (e: StoredEvent) => `${e.requestId}:${String(e.toolCallId)}`;
  const results = new Map<string, { event: StoredEvent; index: number }>();
  const dispatch = new Map<string, { event: StoredEvent; index: number }>();
  const delivered = new Set(events.filter((e) => e.type === "delivery_succeeded").map((e) => e.requestId));
  const ended = new Set(events.filter((e) => e.type === "request_failed" || e.type === "request_completed" ||
    e.type === "request_interrupted")
    .map((e) => e.requestId));
  const used = new Set<string>();
  const calls = new Set<string>();
  const progressSteps = new Set(events.filter((event) => event.type === "text_finalized" &&
    ["progress", "status", "result"].includes(String(event.contentKind)) && typeof event.modelStepId === "string")
    .map((event) => event.modelStepId));
  for (const [index, event] of events.entries()) {
    if (event.type === "tool_result") {
      if (results.has(key(event))) throw new Error("工具结果编号重复");
      results.set(key(event), { event, index });
    }
    if ((event.type === "tool_dispatch" || event.type === "tool_blocked")) dispatch.set(key(event), { event, index });
  }
  const recent = [...new Set(events.filter((e) => e.type === "message" && e.role === "user" &&
    ended.has(e.requestId)).map((e) => e.requestId))].slice(-3);
  let current: Message | undefined;
  let legacyRequest: string | undefined;
  for (const [index, event] of events.entries()) {
    const timestamp = Date.parse(event.at) || 0;
    if (event.type === "message" && event.role === "user" && typeof event.text === "string") {
      const images = Array.isArray(event.images) ? event.images as ImageContent[] : [];
      const message: Message = { role: "user", content: images.length
        ? [{ type: "text", text: event.text }, ...images] : event.text, timestamp };
      if (event.requestId === currentId) current = message;
      legacyRequest = event.requestId ?? `legacy:${index}`;
      units.push({ messages: [message], through: index + 1, requestId: legacyRequest, safe: true });
    } else if (event.type === "message" && event.role === "assistant" && !event.requestId && typeof event.text === "string") {
      units.push({ messages: [replayText("final", event.text, timestamp)], through: index + 1,
        requestId: legacyRequest, safe: true });
    } else if (structured && event.type === "protocol_feedback" && typeof event.text === "string") {
      units.push({ messages: [{ role: "user", content: event.text, timestamp }], through: index + 1,
        requestId: event.requestId, safe: true });
    } else if (event.type === "model_message") {
      const original = event.message as AssistantMessage;
      if (event.protocolVersion && !events.some((e) => e.type === "protocol_validated" &&
        e.modelStepId === event.modelStepId && e.valid === true)) continue;
      if (original?.role !== "assistant" || !Array.isArray(original.content) ||
        original.stopReason === "error" || original.stopReason === "aborted") continue;
      const toolCalls = original.content.filter((c): c is ToolCall => c.type === "toolCall");
      if (!toolCalls.length) continue; // Final text is admitted by delivery, not generation.
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
          const view = replayToolResultView({ result, archive, recorded: found.event.modelVisible,
            archiveRead: log.isArchiveRead(call.name, sent.event.args),
            olderThanRecent: !recent.includes(event.requestId) && event.requestId !== currentId,
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
        const progress = events.find((e) => e.type === "text_finalized" && e.modelStepId === event.modelStepId &&
          ["progress", "status", "result"].includes(String(e.contentKind)));
        const assistant = { ...original, content: original.content.filter((c) =>
          c.type === "toolCall" ? kept.includes(c) : c.type !== "text" || (!structured && !progressSteps.has(event.modelStepId))) };
        if (progress?.contentKind === "result") {
          // Keep execution facts regardless of UI delivery, but never imply unseen text was delivered.
          assistant.content = assistant.content.filter((part) => part.type !== "text");
          const text = String(progress.text);
          if (resultDelivered(progress.textSegmentId)) {
            assistant.content.push({ type: "text", text: structured ? protocolText("result", text) : text });
          } else if (event.requestId === currentId && !ended.has(currentId)) {
            const work = `内部工作成果（尚未确认送达用户）：\n${text}`;
            assistant.content.push({ type: "text", text: structured ? protocolText("status", work) : work });
          }
        } else if (structured && (progress || !event.protocolVersion)) {
          const text = typeof progress?.text === "string" ? progress.text : original.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
          if (text) assistant.content.push({ type: "text", text: protocolText(progress?.contentKind === "status" ? "status" : "progress", text) });
        }
        units.push({ messages: [assistant, ...responses], summaryMessages: [assistant, ...summaryResponses],
          through, requestId: event.requestId, safe });
      }
    } else if (event.type === "text_finalized" && ["progress", "status", "result"].includes(String(event.contentKind)) &&
      typeof event.textSegmentId === "string" && typeof event.text === "string" && event.requestId) {
      if (event.contentKind === "result" && !resultDelivered(event.textSegmentId)) {
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
      units.push({ messages: [replayText(event.contentKind as "progress" | "status" | "result", event.text, timestamp)], through: index + 1,
        requestId: event.requestId, safe: true });
    } else if (event.type === "delivery_succeeded" && event.requestId && delivered.has(event.requestId)) {
      const answer = events.slice(0, index).findLast((e) => e.type === "answer_generated" && e.requestId === event.requestId);
      if (typeof answer?.text === "string") units.push({ messages: [replayText("final", answer.text, timestamp)],
        through: index + 1, requestId: event.requestId, safe: true });
    }
  }
  for (const identity of results.keys()) if (!used.has(identity)) diagnostics.push(`unmatched_tool_result:${identity}`);
  if (!current) throw new Error("缺少当前用户消息");
  return { events, boundary: reset < 0 ? "initial" : sourceDigest(all.slice(0, reset + 1)), units, current, diagnostics };
}
