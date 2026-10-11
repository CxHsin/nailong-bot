import type { Api, AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import type { RuntimeLog, ToolArchive, ToolResult } from "../runtime/runtime-types.js";
import type { HistoryScope } from "../runtime/history-scope.js";
import { interpretHistory, type HistoryFact } from "../runtime/history-facts.js";
import { filterArchivedMemoryResult, filterMemoryToolResult } from "../runtime/memory-exclusion.js";
import { assistantText } from "./model-message.js";
import { protocolText } from "./output-protocol.js";
import { replayableReasoning } from "../context/provider-aware.js";
import { replayToolResultView } from "../context/tool-result-projection.js";

export type EncodedHistoryUnit = { messages: Message[]; summaryMessages?: Message[];
  through: number; requestId?: string; safe: boolean; sourceIds?: string[]; protected?: boolean };
type Archives = Pick<RuntimeLog, "recoverArchive" | "isArchiveRead">;
type EncodedFact = { unit?: EncodedHistoryUnit; current?: Message };
type ArchiveRequest = { archive: ToolArchive; source?: ToolResult };
type ToolEncoding = Generator<ArchiveRequest, EncodedFact, ToolResult>;

function settledText(fact: Extract<HistoryFact, { kind: "text" }>, model: Model<Api>, structured: boolean) {
  let text = fact.text;
  if (fact.unconfirmed) text = `内部工作成果（尚未确认送达用户）：\n${text}`;
  if (fact.auxiliary) text = `运行摘要（来源：独立进展模型，仅依据已记录事实）：\n${text}`;
  const message = assistantText(structured ? protocolText(fact.contentKind, text) : text, model, Date.parse(fact.event.at) || 0);
  const original = fact.original;
  if (!structured && original?.api === model.api && original.provider === model.provider && original.model === model.id) {
    const part = typeof fact.settled?.modelTextIndex === "number" ? original.content[fact.settled.modelTextIndex] :
      original.content.find((part) => part.type === "text" && part.text === text);
    if (part?.type === "text" && part.text === text && part.textSignature) message.content = [{ ...part }];
  }
  return message;
}

/** Stateless Provider encoding; archives are supplied explicitly and facts are never read or appended here. */
function encodeFact(fact: HistoryFact, scope: HistoryScope, model: Model<Api>, structured: boolean, archives: Archives):
  EncodedFact | ToolEncoding {
  const { event } = fact;
  const timestamp = Date.parse(event.at) || 0;
  const base = { through: fact.through, requestId: fact.requestId, safe: fact.safe,
    ...(fact.sourceIds === undefined ? {} : { sourceIds: fact.sourceIds }),
    ...(fact.protected === undefined ? {} : { protected: fact.protected }) };
  switch (fact.kind) {
    case "input": {
      const message: Message = { role: "user", content: fact.images.length ? [{ type: "text", text: fact.text }, ...fact.images] : fact.text, timestamp };
      return { unit: { ...base, messages: [...fact.supplemental, message] }, current: fact.current ? message : undefined };
    }
    case "terminal": return { unit: { ...base, messages: [{ role: "user", timestamp,
      content: `运行层状态记录：Run ${fact.owner} 已${event.type === "run_cancelled" ? "停止" : "失败"}。已完成的操作保留；不要自动续做已停止的任务或执行已取消的待处理输入，后续工作以新的用户输入为准。` }] } };
    case "recorded": return { unit: { ...base, messages: fact.messages } };
    case "skill": return { unit: { ...base, messages: [{ role: "user", timestamp,
      content: `运行层按用户显式引用加载的 skill 指令（${String(event.source)}:${String(event.name)}；根目录 ${String(event.root)}；版本 ${String(event.digest)}）：\n${event.body}` }] } };
    case "feedback": return { unit: { ...base, messages: [{ role: "user", content: fact.text, timestamp }], summaryMessages: [] } };
    case "text": return { unit: { ...base, messages: [settledText(fact, model, structured)] } };
    case "model": break;
  }
  if (!fact.pairs.length) {
    const reasoning = replayableReasoning(fact.original, model);
    return scope.host && reasoning.length ? { unit: { ...base, messages: [{ ...fact.original, content: reasoning }] } } : {};
  }
  return encodeToolStep(fact, scope, model, structured, archives, base, timestamp);
}

function* encodeToolStep(fact: Extract<HistoryFact, { kind: "model" }>, scope: HistoryScope, model: Model<Api>, structured: boolean,
  archives: Archives, base: Omit<EncodedHistoryUnit, "messages" | "summaryMessages">, timestamp: number): ToolEncoding {
  const { original, progresses, event } = fact;
  const kept = fact.pairs.map((pair) => pair.call);
  const responses: Message[] = [];
  const summaryResponses: Message[] = [];
  for (const pair of fact.pairs) {
    const { call } = pair;
    if (pair.outcome === "unknown") {
      const message: Message = { role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true, timestamp,
        content: [{ type: "text", text: `outcome_unknown:${pair.identity}: 工具已派发，但没有持久结果；可能已产生副作用。先检查现状，不要盲目重试。` }] };
      responses.push(message); summaryResponses.push(message); continue;
    }
    const resultEvent = pair.result;
    const archive = resultEvent.archive as ToolArchive | undefined;
    let result = archive ? yield { archive, source: resultEvent.result as ToolResult | undefined } : resultEvent.result as ToolResult;
    if (!result || !Array.isArray(result.content)) throw new Error("缺少完整工具结果");
    const unfiltered = result;
    result = filterArchivedMemoryResult(scope.raw, resultEvent, filterMemoryToolResult(call.name, result, scope.excluded), scope.excluded);
    const view = replayToolResultView({ result, archive, projectionVersion: resultEvent.modelProjectionVersion,
      modelProjection: resultEvent.modelProjection, sourceResult: unfiltered, sourceFiltered: result !== unfiltered,
      recorded: resultEvent.modelVisible, archiveRead: archives.isArchiveRead(call.name, pair.dispatch.args), olderThanRecent: false, toolName: call.name });
    const resultTimestamp = Date.parse(resultEvent.at) || 0;
    responses.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: view.content, details: view.details, isError: result.isError, timestamp: resultTimestamp });
    summaryResponses.push({ role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: structuredClone(result.content), details: result.details, isError: result.isError, timestamp: resultTimestamp });
  }
  const progress = progresses[0];
  const assistant: AssistantMessage = { ...original, content: original.content.filter((part) => part.type === "toolCall" ? kept.includes(part) :
    part.type === "thinking" ? !scope.host : part.type !== "text" || (!structured && !fact.progressStep)) };
  if (scope.host) assistant.content.unshift(...replayableReasoning(original, model));
  if (event.protocolVersion === "plain-text-v3") {
    assistant.content = original.content.filter((part, index) => {
      if (part.type === "toolCall") return kept.includes(part);
      if (part.type === "thinking") return false;
      return progresses.some((settled) => typeof settled.modelTextIndex === "number" ? settled.modelTextIndex === index && settled.text === part.text : settled.text === part.text);
    });
    if (scope.host) assistant.content.unshift(...replayableReasoning(original, model));
  } else if (progress?.contextPolicy === "include" && typeof progress.text === "string") {
    assistant.content = assistant.content.filter((part) => part.type !== "text");
    assistant.content.push({ type: "text", text: progress.text });
  }
  if (progress?.contentKind === "result") {
    assistant.content = assistant.content.filter((part) => part.type !== "text");
    const text = String(progress.text);
    if (scope.host || fact.resultDelivered) assistant.content.push({ type: "text", text: structured ? protocolText("result", text) : text });
    else if (fact.activeCurrent) {
      const work = `内部工作成果（尚未确认送达用户）：\n${text}`;
      assistant.content.push({ type: "text", text: structured ? protocolText("status", work) : work });
    }
  } else if (structured && (progress || !event.protocolVersion) && !scope.host) {
    const text = typeof progress?.text === "string" ? progress.text : original.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (text) assistant.content.push({ type: "text", text: protocolText(progress?.contentKind === "status" ? "status" : "progress", text) });
  }
  return { unit: { ...base, messages: [assistant, ...responses], summaryMessages: [assistant, ...summaryResponses] } };
}

/** Consume pure visits cooperatively; caller supplies cancellation, progress and the source suffix. */
export async function encodeHistory(scope: HistoryScope, currentId: string, model: Model<Api>, structured: boolean, archives: Archives,
  options: { start?: number; signal?: AbortSignal; onProgress?: (checked: number, total: number) => void } = {}) {
  const start = options.start ?? 0;
  const visits = interpretHistory(scope, currentId, structured, start);
  const units: EncodedHistoryUnit[] = [];
  let current: Message | undefined;
  while (true) {
    const visit = visits.next();
    if (visit.done) {
      if (!current) throw new Error("缺少当前用户消息");
      return { units, current, diagnostics: visit.value };
    }
    if (visit.value.kind === "pause") {
      if (options.signal?.aborted) throw new DOMException("历史恢复已取消", "AbortError");
      if (visit.value.phase === "replay") options.onProgress?.(visit.value.index - start, scope.events.length - start);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } else {
      // Keep ordinary fact encoding synchronous; only archive-backed steps and
      // the original cooperative boundaries suspend restoration.
      const value = encodeFact(visit.value.fact, scope, model, structured, archives);
      let encoded: EncodedFact;
      if ("next" in value) {
        let step = value.next();
        while (!step.done) {
          let result: ToolResult;
          try { result = await archives.recoverArchive(step.value.archive, step.value.source); }
          catch { throw new Error("工具归档缺失或校验失败"); }
          step = value.next(result);
        }
        encoded = step.value;
      } else encoded = value;
      if (encoded.unit) units.push(encoded.unit);
      if (encoded.current) current = encoded.current;
    }
  }
}
