import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, getModel, isContextOverflow } from "@mariozechner/pi-ai";
import {
  AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry,
  SessionManager, SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "./app.js";
import type { Request } from "./app.js";
import { connectTinyfish } from "./tinyfish.js";
import { createContextProjection } from "./context-budget.js";
import { assistantText } from "./projection.js";
import { type ToolResult } from "./runtime-log.js";
import { toolResultView, TOOL_RESULT_PROJECTION_VERSION } from "./tool-result-projection.js";
import { createBoundedRead } from "./archive-read.js";
import { createRuntimeLog } from "./runtime-log.js";

export async function createPiAgent(options: {
  dataDir: string;
  promptFile: string;
  deepseekKey: string;
  tinyfishKey?: string;
  modelBaseUrl?: string;
  tinyfishUrl?: string;
  contextWindow?: number;
  contextBudgetRatio?: number;
  modelBudgetRatios?: Record<string, number>;
}) {
  const systemPrompt = (await readFile(options.promptFile, "utf8")).trim();
  if (!systemPrompt) throw new Error("System prompt 文件为空");
  let tinyfish: Awaited<ReturnType<typeof connectTinyfish>> | undefined;
  if (options.tinyfishKey) {
    try { tinyfish = await connectTinyfish(options.tinyfishKey, options.tinyfishUrl); }
    catch { console.error("TinyFish 暂不可用，网页查询工具未启用。"); }
  }
  const defaultModel = getModel("deepseek", "deepseek-v4-flash");
  if (!defaultModel) throw new Error("pi SDK 未提供 DeepSeek 模型");
  const model = { ...defaultModel, id: "deepseek-flash", name: "deepseek-flash",
    ...(options.modelBaseUrl ? { baseUrl: options.modelBaseUrl } : {}),
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }) };
  const authStorage = AuthStorage.create(join(options.dataDir, "auth.json"));
  authStorage.setRuntimeApiKey("deepseek", options.deepseekKey);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: options.dataDir, agentDir: options.dataDir,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    settingsManager,
  });
  await loader.reload();

  return {
    async answer(messages: Message[], request?: Request): Promise<string> {
      const current = messages.at(-1);
      if (!current || current.role !== "user") throw new Error("缺少用户消息");
      const manager = SessionManager.inMemory(options.dataDir);
      for (const message of request ? [] : messages.slice(0, -1)) {
        if (message.role === "user") {
          manager.appendMessage({ role: "user", content: message.text, timestamp: Date.now() });
        } else {
          manager.appendMessage(assistantText(message.text, model));
        }
      }
      const { session } = await createAgentSession({
        cwd: options.dataDir, agentDir: options.dataDir,
        authStorage, modelRegistry: ModelRegistry.create(authStorage),
        settingsManager, resourceLoader: loader, model, thinkingLevel: "off",
        tools: ["read", "write", "edit", "ls", "find", "grep", ...(tinyfish ? ["web_search", "web_fetch"] : [])],
        customTools: [createBoundedRead(options.dataDir, request?.log ?? createRuntimeLog(options.dataDir)),
          ...(tinyfish?.tools ?? [])], sessionManager: manager,
      });
      let logFailure: Error | undefined;
      let projectionFailure: Error | undefined;
      if (request) {
        let step = 0;
        const providerStream = session.agent.streamFn;
        const projection = createContextProjection({ log: request.log, dataDir: options.dataDir, requestId: request.id,
          ratio: options.contextBudgetRatio, ratios: options.modelBudgetRatios,
          summarize: async (context, maxTokens) => {
            const stream = await providerStream(model, context, { maxTokens, signal: session.agent.signal });
            for await (const _event of stream) { /* Drain snapshots rather than retaining them. */ }
            const response = await stream.result();
            if (response.stopReason !== "stop") throw new Error("历史摘要生成未完整结束");
            return response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
          },
        });
        session.agent.streamFn = async (selected, context, streamOptions) => {
          try { for (let attempt = 0; attempt < 2; attempt++) {
            const result = await projection.project(selected, context, attempt === 1);
            const currentStep = ++step;
            const modelStepId = randomUUID();
            const textSegmentId = randomUUID();
            await request.log.append({ type: "model_step_started", requestId: request.id,
              step: currentStep, modelStepId });
            const source = await providerStream(selected, result.context, { ...streamOptions, maxTokens: result.maxTokens });
            let producedOutput = false;
            let text = "";
            let saved = "";
            let lastSnapshot = 0;
            const snapshot = async () => {
              if (!text || text === saved) return;
              await request.log.append({ type: "text_snapshot", requestId: request.id,
                modelStepId, textSegmentId, contentKind: "provisional", text });
              saved = text;
              lastSnapshot = Date.now();
              await request.onText?.(textSegmentId);
            };
            for await (const event of source) {
              if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
                producedOutput = true;
              }
              if (event.type === "text_delta") {
                text += event.delta;
                const threshold = saved ? 3 : 1;
                if (text.length - saved.length >= threshold && (!saved || Date.now() - lastSnapshot >= 150)) {
                  await snapshot();
                }
              }
            }
            const message = await source.result();
            if (attempt === 0 && message.stopReason === "error" && !producedOutput && !message.content.length &&
              isContextOverflow(message, selected.contextWindow)) {
              await request.log.append({ type: "provider_overflow", requestId: request.id, retry: 1 });
              continue;
            }
            if (message.stopReason === "error" && isContextOverflow(message, selected.contextWindow)) {
              throw new Error(producedOutput ? "模型上下文溢出且已有部分输出" : "模型上下文溢出重试失败");
            }
            const settledText = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
            if (settledText) {
              text = settledText;
              await snapshot();
              if (message.stopReason !== "error" && message.stopReason !== "aborted") {
                await request.log.append({ type: "text_finalized", requestId: request.id,
                  modelStepId, textSegmentId,
                  contentKind: message.content.some((part) => part.type === "toolCall") ? "progress" : "final",
                  text: settledText });
                await request.onText?.(textSegmentId);
              }
            }
            await request.log.append({ type: "model_message", requestId: request.id,
              step: currentStep, modelStepId, message });
            for (const part of message.content) {
              if (part.type === "toolCall") {
                await request.log.append({ type: "tool_call", requestId: request.id,
                  toolCallId: part.id, toolName: part.name, args: part.arguments });
              }
            }
            await request.log.append({ type: "model_step_completed", requestId: request.id,
              step: currentStep, modelStepId, stopReason: message.stopReason });
            // Deliver only the settled physical attempt to Pi. A rejected request cannot issue tools.
            const response = createAssistantMessageEventStream();
            if (message.stopReason === "error" || message.stopReason === "aborted") {
              response.push({ type: "error", reason: message.stopReason, error: message });
            } else response.push({ type: "done", reason: message.stopReason, message });
            return response;
          }
          throw new Error("模型上下文溢出重试失败");
          } catch (error) {
            projectionFailure = error instanceof Error ? error : new Error(String(error));
            throw error;
          }
        };
        session.agent.toolExecution = "sequential";
        const originalBefore = session.agent.beforeToolCall;
        const originalAfter = session.agent.afterToolCall;
        const recordResult = async (toolCallId: string, toolName: string, result: ToolResult, args?: unknown) => {
          let archive: Awaited<ReturnType<Request["log"]["archive"]>> | undefined;
          let archiveError: string | undefined;
          try { archive = await request.log.archive(result); }
          catch (error) { archiveError = String(error); }
          const view = toolResultView(toolName, result, archive, request.log.isArchiveRead(toolName, args));
          await request.log.append({ type: "tool_result", requestId: request.id,
            toolCallId, toolName, isError: result.isError,
            modelVisible: view.modelVisible, modelProjectionVersion: TOOL_RESULT_PROJECTION_VERSION,
            result, ...(archive ? { archive } : { archiveError }) });
          return view;
        };
        session.agent.beforeToolCall = async (context, signal) => {
          if (logFailure) return { block: true, reason: "运行日志写入失败" };
          const previous = await originalBefore?.(context, signal);
          if (previous?.block) return previous;
          if (request.log.isArchiveRead(context.toolCall.name, context.args)) {
            const args = context.args as { limit?: number };
            args.limit = Math.min(Math.max(1, args.limit ?? 120), 120);
          }
          try {
            await request.log.append({ type: "tool_dispatch", requestId: request.id,
              toolCallId: context.toolCall.id, toolName: context.toolCall.name, args: context.args });
          } catch (error) {
            logFailure = error instanceof Error ? error : new Error(String(error));
            session.agent.abort();
            return { block: true, reason: "运行日志写入失败" };
          }
          return previous;
        };
        session.agent.afterToolCall = async (context, signal) => {
          if (logFailure) return { content: [{ type: "text", text: "运行日志写入失败" }], terminate: true };
          const previous = await originalAfter?.(context, signal);
          const result = {
            content: previous?.content ?? context.result.content,
            details: previous?.details ?? context.result.details,
            isError: previous?.isError ?? context.isError,
          };
          let view: ReturnType<typeof toolResultView>;
          try {
            view = await recordResult(context.toolCall.id, context.toolCall.name, result, context.args);
          } catch (error) {
            logFailure = error instanceof Error ? error : new Error(String(error));
            session.agent.abort();
            return { content: [{ type: "text", text: "工具结果未能写入运行日志；本轮已停止。" }], terminate: true };
          }
          if (view.modelVisible === "original") return previous;
          return { content: view.content, details: {} };
        };
      }
      try {
        await session.prompt(current.text);
        if (logFailure) throw logFailure;
        if (projectionFailure) throw projectionFailure;
        const last = session.messages.at(-1);
        if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
          throw new Error("模型调用失败");
        }
        return session.getLastAssistantText() ?? "";
      } finally { session.dispose(); }
    },
    async close(): Promise<void> { await tinyfish?.close(); },
  };
}
