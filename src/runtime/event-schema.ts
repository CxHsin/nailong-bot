import type { AssistantMessage, Message, Usage } from "@mariozechner/pi-ai";
import type { EventInput } from "./sqlite-runtime-log.js";
import type { ToolArchive, ToolResult, RecordedToolProjection } from "./runtime-types.js";
import type { ContentPart } from "../host/content-parts.js";
import type { PublicTextPhase, RunProgress } from "./progress.js";
import type { TransportCause } from "./transport-diagnostics.js";
import type { BuildIdentity } from "./build-identity.js";
import { validModelAlias } from "../agent/model-config.js";

type RequestFact = { requestId: string };
type ToolFact = RequestFact & { toolCallId: string; toolName: string };
type ContentFact = RequestFact & { textSegmentId: string };
type PageFact = ContentFact & { partIndex: number; target: number };
type HostFact = { runId: string; conversationId: string; actorId?: string; phase?: string;
  source?: "runtime" | "provider" | "channel"; visibility?: "quiet" | "normal" | "verbose" | "always";
  text?: string; error?: string; reason?: string; parts?: ContentPart[]; receiptId?: string;
  cancelledInputs?: number; inputKey?: string; progress?: RunProgress; result?: Record<string, unknown> };
type ModelCall = RequestFact & { callId: string; purpose: string; provider: string; model: string };
type ModelStep = RequestFact & { modelStepId: string; step: number };
type CatalogTool = { name: string; source: string; originalName: string; description: string; parameters: unknown; digest: string };
type OriginalCoverage = { kind: "original"; nodeId: string; messageId: string; offset: number; end: number; complete: boolean };
type ShownMemory = { nodeId: string; messageId: string; offset: number; end: number; existing: boolean };
type ContextInput = RequestFact & { messages: Message[]; shown: ShownMemory[]; tokens: number;
  memoryCoverage: OriginalCoverage[]; memoryNodeIds: string[] };

/** The current production facts. Raw historical/unknown records stay on RuntimeLog's compatibility boundary. */
type RuntimeFactShapes = {
  command_received: { command: string; messageId?: unknown; contextPolicy: "exclude" };
  input_received: { chatId: number; messageId: number; intent?: string; replyToMessageId?: number; diagnosticInspection?: boolean };
  bot_prompt_config: { chatId: number; version: string; text?: string };
  memory_excluded: { nodeId: string; userId: number; messageId: number; replyToMessageId?: number; intent: string };
  memory_degraded: ({ requestId: string } | { userId: number }) & { reason: string };
  runtime_identity: RequestFact & { identity: BuildIdentity; contextPolicy: "exclude" };
  context_feed: { contextPolicy: "exclude" };
  context_feed_consumed: RequestFact & { contextPolicy: "exclude" };
  model_selected: { conversationId: string; modelAlias: string; contextPolicy: "exclude" };
  message: RequestFact & { role: "user" | "assistant"; text: string; originalText?: string; chatId?: number;
    messageId?: unknown; replyToMessageId?: number; replyContext?: unknown; images?: unknown[]; inputId?: string; inputKind?: "steer" };
  run_submitted: HostFact;
  run_started: HostFact;
  run_succeeded: HostFact & { result: Record<string, unknown> & { resultId: string } };
  run_failed: HostFact;
  run_cancelled: HostFact;
  run_blocked: HostFact;
  run_recovered: HostFact;
  conversation_reset: Partial<HostFact> & { conversationId: string; source?: "runtime" | "provider" | "channel" };
  input_receipt: HostFact;
  control_received: HostFact;
  control_completed: HostFact;
  steer_consumed: RequestFact & { inputId: string; conversationId: string; contextPolicy: "exclude" };
  request_started: RequestFact;
  request_completed: RequestFact;
  request_failed: RequestFact & { error?: string; phase?: string };
  request_interrupted: RequestFact;
  model_message: RequestFact & { modelStepId: string; message: AssistantMessage; step?: number; protocolVersion?: string };
  model_step_started: ModelStep & { purpose: "execution"; provider: string; model: string; systemPrompt?: string; cacheKey?: string; stablePrefixKey: string };
  model_step_completed: ModelStep & { stopReason: AssistantMessage["stopReason"] };
  model_call_started: ModelCall;
  model_usage: ModelCall & { usageAvailable: boolean; usage: Usage; stopReason: AssistantMessage["stopReason"]; providerTimestamp: number };
  model_transport: ModelCall & { causes: TransportCause[]; httpStatus: number | null; providerRequestId: string | null; headersMs: number | null;
    elapsedMs: number; stopReason: AssistantMessage["stopReason"]; firstStreamEventMs: number | null; firstPublicTextMs: number | null;
    terminalEventMs: number | null; normalTerminal: boolean; abortSource: "none" | "run-signal" | "provider-signal" | "timeout-signal";
    abortMs: number | null; runSignalAborted: boolean; providerSignalAborted: boolean; configuredTimeoutMs: number | null;
    errorCategory: "none" | "stream_terminated" | "network" | "aborted" | "context_overflow" | "unknown"; contextPolicy: "exclude" };
  tool_dispatch: ToolFact & { args: unknown };
  tool_call: ToolFact & { args: unknown };
  tool_blocked: ToolFact & { args?: unknown; reason?: string };
  tool_result: ToolFact & { result: ToolResult; isError: boolean; modelVisible: "original" | "archive";
    modelProjectionVersion: number; modelProjection: RecordedToolProjection; archive?: ToolArchive; archiveError?: string };
  tool_discovered: RequestFact & { query: string; tools: CatalogTool[] };
  capability_snapshot: RequestFact & { catalogDigest: string; skillsDigest: string; mode: "native" | "compat"; unavailableSources: string[]; tools: CatalogTool[] };
  capability_dispatched: ToolFact & { source: string; digest: string; args: unknown };
  capability_executed: ToolFact & { source: string; digest: string; result: { content: ToolResult["content"]; details: unknown } };
  text_finalized: ContentFact & { text: string; contentKind: "progress" | "final" | "status" | "result";
    source?: "execution" | "progress-model"; evidenceIds?: string[]; modelStepId?: string; modelTextIndex?: number; protocolVersion?: string } & Partial<PublicTextPhase>;
  text_discarded: ContentFact & { reason?: string; modelStepId?: string };
  telegram_page: PageFact & { text: string; contentKind: "progress" | "final" };
  telegram_plan_finalized: ContentFact & { parts: number };
  telegram_delivery_attempt: PageFact & { attemptId: string };
  telegram_delivery_succeeded: PageFact & { attemptId: string; telegramMessageId: number };
  telegram_delivery_failed: PageFact & { attemptId: string; error: string };
  telegram_delivery_unknown: PageFact & { attemptId: string; error: string };
  delivery_succeeded: RequestFact & { runId: string; resultId: string; channel: "telegram" | "cli"; telegramMessageId?: number; stageSegmentIds?: unknown };
  answer_generated: RequestFact & { text: string; resultId: string };
  context_input_snapshot: ContextInput;
  context_input_updated: ContextInput;
  context_phase_timing: RequestFact & { restoreMs: number; selectMs: number; loadMs: number; contextPolicy: "exclude" };
  context_projected: RequestFact & { estimatedTokens: number; initialTokens: number; budget: number; trigger: number; target: number;
    compactionAttempts: number; releasedTokens: number; degraded?: string; checkpointId?: string;
    coverage: { originalIds: string[]; summaryIds: string[] }; diagnostics: string[]; logBytes: number; replayMs: number; replayProcessedEvents?: number; processPeakRssBytes: number };
  compaction_failed: RequestFact & { failureKey: string; reason: string; attempts: number; initialTokens: number; budget: number; target: number; contextPolicy: "exclude" };
};

export type RuntimeFactType = keyof RuntimeFactShapes;
export type RuntimeFactOf<T extends RuntimeFactType> = { [K in T]: { type: K; at?: string; conversationId?: string; contextPolicy?: "include" | "exclude" } & RuntimeFactShapes[K] }[T];
export type RuntimeSemanticFact = RuntimeFactOf<RuntimeFactType>;

/** Validate before the transaction writes anything; previews do not enter this boundary. */
export function validateRuntimeFact(event: EventInput): void {
  const strings = (...fields: string[]) => {
    for (const field of fields) if (typeof event[field] !== "string" || !String(event[field]).trim()) throw new Error(`运行事实缺少关联身份或内容：${field}`);
  };
  const integer = (field: string, minimum: number) => {
    if (!Number.isSafeInteger(event[field]) || Number(event[field]) < minimum) throw new Error(`运行事实数字无效：${field}`);
  };
  const type = String(event.type);
  if (type === "model_selected") {
    strings("conversationId");
    if (!validModelAlias(event.modelAlias) || event.contextPolicy !== "exclude") throw new Error("模型选择事实无效");
  }
  if (["run_submitted", "run_started", "run_succeeded", "run_failed", "run_cancelled"].includes(type)) strings("runId");
  if (type === "run_succeeded" && (!event.result || typeof event.result !== "object")) throw new Error("成功 Run 缺少结算结果");
  if (["request_started", "request_completed", "request_failed", "request_interrupted"].includes(type)) strings("requestId");
  if (type === "message") {
    if (!["user", "assistant"].includes(String(event.role)) || typeof event.text !== "string") throw new Error("消息缺少角色或文字");
  }
  if (["model_step_started", "model_step_completed", "model_message"].includes(type)) strings("requestId", "modelStepId");
  if (type === "model_message") {
    const message = event.message as AssistantMessage | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) throw new Error("模型结算缺少 assistant 消息");
  }
  if (["model_call_started", "model_usage"].includes(type)) strings("requestId", "callId", "purpose", "provider", "model");
  if (["tool_call", "tool_dispatch", "tool_result", "tool_blocked"].includes(type)) strings("requestId", "toolCallId", "toolName");
  if (type === "tool_result") {
    const result = event.result as ToolResult | undefined;
    if (!Array.isArray(result?.content) || typeof result.isError !== "boolean") throw new Error("工具事实缺少完整结果");
  }
  if (type === "text_finalized" || type === "text_discarded") strings("requestId", "textSegmentId");
  if (type === "text_finalized") {
    strings("text");
    if (!["progress", "final", "result", "status"].includes(String(event.contentKind))) throw new Error("结算文字用途无效");
    if (event.source !== undefined && !["execution", "progress-model"].includes(String(event.source))) throw new Error("结算文字来源无效");
    if (event.source === "progress-model" && (!Array.isArray(event.evidenceIds) || !event.evidenceIds.length || event.evidenceIds.some((id) => typeof id !== "string"))) throw new Error("运行摘要缺少事实依据");
  }
  if (type === "telegram_page" || type === "telegram_plan_finalized" || type.startsWith("telegram_delivery_")) strings("requestId", "textSegmentId");
  if (type === "telegram_plan_finalized") integer("parts", 1);
  if (type === "telegram_page" || type.startsWith("telegram_delivery_")) { integer("partIndex", 0); integer("target", 1); }
  if (type === "telegram_page") strings("text");
  if (type.startsWith("telegram_delivery_")) strings("attemptId");
  if (type === "telegram_delivery_succeeded") integer("telegramMessageId", 1);
}
