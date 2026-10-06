import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { EventInput } from "./sqlite-runtime-log.js";
import type { ToolResult } from "./runtime-types.js";
import { validModelAlias } from "../agent/model-config.js";

type RequestFact = { requestId: string; conversationId?: string };
type ToolFact = RequestFact & { toolCallId: string; toolName: string };
type ContentFact = RequestFact & { textSegmentId: string };
type PageFact = ContentFact & { partIndex: number; target: number };
/** Core v2 semantic shapes. Legacy and memory metadata retain their own compatibility schemas. */
export type RuntimeSemanticFact =
  | ({ type: "model_selected"; conversationId: string; modelAlias: string; contextPolicy: "exclude" })
  | (RequestFact & { type: "message"; role: "user" | "assistant"; text: string })
  | ({ type: "run_submitted" | "run_started" | "run_succeeded" | "run_failed" | "run_cancelled"; runId: string; conversationId?: string; result?: Record<string, unknown> })
  | (RequestFact & { type: "request_started" | "request_completed" | "request_failed" | "request_interrupted" })
  | (RequestFact & { type: "model_message"; modelStepId: string; message: AssistantMessage })
  | (ToolFact & { type: "tool_dispatch" | "tool_call" | "tool_blocked"; args?: unknown })
  | (ToolFact & { type: "tool_result"; result: ToolResult })
  | (ContentFact & { type: "text_finalized"; text: string; contentKind: "progress" | "final" | "status" | "result"; source?: "execution" | "progress-model"; evidenceIds?: string[] })
  | (ContentFact & { type: "text_discarded"; reason?: string })
  | (PageFact & { type: "telegram_page"; text: string })
  | (ContentFact & { type: "telegram_plan_finalized"; parts: number })
  | (PageFact & { type: "telegram_delivery_attempt" | "telegram_delivery_succeeded" | "telegram_delivery_failed" | "telegram_delivery_unknown"; attemptId: string; telegramMessageId?: number });

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
