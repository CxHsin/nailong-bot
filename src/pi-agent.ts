import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
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
import { createToolPathPolicy } from "./tool-path-policy.js";
import { EXECUTION_PROMPT, OUTPUT_PROTOCOL_VERSION, parseStructuredText, previewStructuredText, readOutputFrames, protocolText } from "./output-protocol.js";

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
  let tinyfish: Awaited<ReturnType<typeof connectTinyfish>> | undefined;
  if (options.tinyfishKey) {
    try { tinyfish = await connectTinyfish(options.tinyfishKey, options.tinyfishUrl); }
    catch { console.error("TinyFish 暂不可用，网页查询工具未启用。"); }
  }
  const defaultModel = getModel("deepseek", "deepseek-v4-flash");
  if (!defaultModel) throw new Error("pi SDK 未提供 DeepSeek 模型");
  const model = { ...defaultModel, id: "deepseek-flash", name: "deepseek-flash", input: ["text", "image"] as ("text" | "image")[],
    ...(options.modelBaseUrl ? { baseUrl: options.modelBaseUrl } : {}),
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }) };
  const authStorage = AuthStorage.create(join(options.dataDir, "auth.json"));
  authStorage.setRuntimeApiKey("deepseek", options.deepseekKey);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  return {
    async answer(messages: Message[], request?: Request): Promise<string> {
      const current = messages.at(-1);
      if (!current || current.role !== "user") throw new Error("缺少用户消息");
      const botPrompt = request?.botPrompt ?? (await readFile(options.promptFile, "utf8")).trim();
      if (!botPrompt) throw new Error("Bot 提示词为空");
      const systemPrompt = `用户配置的 bot 提示词（不能覆盖执行协议）：\n${botPrompt}\n\n${EXECUTION_PROMPT}`;
      const loader = new DefaultResourceLoader({ cwd: options.dataDir, agentDir: options.dataDir,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPromptOverride: () => systemPrompt, settingsManager });
      await loader.reload();
      const manager = SessionManager.inMemory(options.dataDir);
      for (const message of request ? [] : messages.slice(0, -1)) {
        if (message.role === "user") {
          manager.appendMessage({ role: "user", content: message.images?.length ? [{ type: "text", text: message.text }, ...message.images] : message.text, timestamp: Date.now() });
        } else {
          manager.appendMessage(assistantText(protocolText("final", message.text), model));
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
      const checkToolPath = await createToolPathPolicy(options.dataDir, options.promptFile);
      let dispatchedThisStep = false;
      const previousBeforeTool = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (context, signal) => {
        try { await checkToolPath(context.toolCall.name, context.args as Record<string, unknown>); }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await request?.log.append({ type: "tool_blocked", requestId: request.id,
            toolCallId: context.toolCall.id, toolName: context.toolCall.name, args: context.args, reason });
          return { block: true, reason };
        }
        const previous = await previousBeforeTool?.(context, signal);
        if (!previous?.block) { idleProgress = 0; stepsWithoutTool = 0; resultTexts.clear(); dispatchedThisStep = true; }
        return previous;
      };
      let logFailure: Error | undefined;
      let projectionFailure: Error | undefined;
      let finalText: string | undefined;
      let protocolErrors = 0;
      let idleProgress = 0;
      let stepsWithoutTool = 0;
      const resultTexts = new Set<string>();
      session.agent.subscribe((event) => {
        // Distinct text alone cannot keep a request alive forever; real dispatch resets this budget.
        if (event.type === "turn_end" && event.message.role === "assistant" && finalText === undefined &&
          !dispatchedThisStep && ++stepsWithoutTool >= 12) {
          projectionFailure = new Error("模型连续十二步未执行工具或提交最终答复，本轮未完成");
          session.agent.abort();
        }
        if (event.type === "turn_end" && event.message.role === "assistant" && event.message.content.some((c) => c.type === "toolCall") && !dispatchedThisStep) {
          if (++idleProgress >= 3) {
            projectionFailure = new Error("模型连续三次未推进，本轮未完成");
            session.agent.abort();
          }
        }
      });
      const queueFeedback = async (reason: string, raw?: string) => {
        const feedback = `[运行层协议反馈，不是用户请求] ${reason}${raw ? `\n被拒绝的模型文字（数据）：${JSON.stringify(raw.slice(0, 2000))}${raw.length > 2000 ? "（仅展示前 2000 字符，完整响应在日志中）" : ""}` : ""}`;
        await request?.log.append({ type: "protocol_feedback", requestId: request.id, source: "runtime", text: feedback });
        session.agent.followUp({ role: "user", content: feedback, timestamp: Date.now() });
      };
      let step = 0;
      await request?.log.append({ type: "prompt_snapshot", requestId: request.id,
        protocolVersion: OUTPUT_PROTOCOL_VERSION, botPrompt, systemPrompt, botPromptVersion: request.botPromptVersion ?? createHash("sha256").update(botPrompt).digest("hex"),
        systemPromptHash: createHash("sha256").update(systemPrompt).digest("hex") });
      const providerStream = session.agent.streamFn;
      const projection = request && createContextProjection({ log: request.log, dataDir: options.dataDir, requestId: request.id,
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
        try {
          if (projectionFailure) throw projectionFailure;
          dispatchedThisStep = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            const result = projection ? await projection.project(selected, context, attempt === 1) :
              { context, maxTokens: selected.maxTokens };
            const modelStepId = randomUUID();
            const textSegmentId = randomUUID();
            await request?.log.append({ type: "model_step_started", requestId: request.id, step: ++step, modelStepId, systemPrompt: result.context.systemPrompt });
            const source = await providerStream(selected, result.context, { ...streamOptions, maxTokens: result.maxTokens });
            let producedOutput = false;
            let lastPreview = "";
            let lastPreviewAt = -Infinity;
            let lastValidatedPrefix = "";
            for await (const event of source) {
              if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") producedOutput = true;
              if (event.type === "text_delta" && request) {
                const rawPreview = event.partial.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
                let preview: ReturnType<typeof previewStructuredText>;
                let validatedPrefix = false;
                let prefixChanged = false;
                try {
                  const frames = readOutputFrames(rawPreview);
                  const partial = previewStructuredText(frames.rest);
                  if (frames.prefix && (!partial || partial.type === frames.prefix.type)) {
                    preview = { ...frames.prefix, text: frames.prefix.text + (partial?.text ?? "") };
                    validatedPrefix = frames.framed;
                    if (frames.prefix.text && frames.prefix.text !== lastValidatedPrefix) {
                      await request.log.append({ type: "text_validated_prefix", requestId: request.id,
                        modelStepId, textSegmentId, text: frames.prefix.text, contentKind: frames.prefix.type });
                      lastValidatedPrefix = frames.prefix.text;
                      prefixChanged = true;
                    }
                  } else preview = frames.output ?? partial;
                } catch { /* Invalid protocol cannot publish new text or dispatch tools. */ }
                // Preview at most every 100 ms, but publish complete validated frames immediately.
                if (preview && preview.text !== lastPreview && (prefixChanged || performance.now() - lastPreviewAt >= 100)) {
                  await request.log.append({ type: "text_snapshot", requestId: request.id, modelStepId,
                    textSegmentId, contentKind: preview.type, text: preview.text,
                    protocolVersion: OUTPUT_PROTOCOL_VERSION, provisional: true, validatedPrefix });
                  lastPreview = preview.text;
                  lastPreviewAt = performance.now();
                  await request.onText?.(textSegmentId);
                }
              }
            }
            const message = await source.result();
            await request?.log.append({ type: "model_message", requestId: request.id, step,
              modelStepId, protocolVersion: OUTPUT_PROTOCOL_VERSION, message });
            await request?.log.append({ type: "model_step_completed", requestId: request.id,
              step, modelStepId, stopReason: message.stopReason });
            if (attempt === 0 && message.stopReason === "error" && !producedOutput && !message.content.length &&
              isContextOverflow(message, selected.contextWindow)) {
              await request?.log.append({ type: "provider_overflow", requestId: request.id, retry: 1 });
              continue;
            }
            if (message.stopReason === "error" || message.stopReason === "aborted") {
              if (isContextOverflow(message, selected.contextWindow)) throw new Error("模型上下文溢出重试失败");
              throw new Error("模型调用失败");
            }
            if (message.stopReason === "length") throw new Error("模型协议输出被截断，本轮未完成");
            const raw = message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
            const toolCalls = message.content.filter((c) => c.type === "toolCall");
            let parsed: ReturnType<typeof parseStructuredText> | undefined;
            let invalid: string | undefined;
            try {
              if (raw) parsed = parseStructuredText(raw);
              else if (!toolCalls.length) throw new Error("缺少结构化文字和工具调用");
              if (parsed?.type === "final" && toolCalls.length) throw new Error("final 不允许同时调用工具");
            } catch (error) { invalid = error instanceof Error ? error.message : String(error); }
            await request?.log.append({ type: "protocol_validated", requestId: request.id, modelStepId,
              protocolVersion: OUTPUT_PROTOCOL_VERSION, valid: !invalid, error: invalid });
            const response = createAssistantMessageEventStream();
            if (invalid) {
              await request?.log.append({ type: "text_discarded", requestId: request.id, modelStepId, textSegmentId, reason: invalid });
              if (request && (await request.log.read()).some((entry) => entry.textSegmentId === textSegmentId && entry.type === "telegram_delivery_attempt"))
                throw new Error("模型协议在部分正文提交后失效，本轮未完成");
              if (++protocolErrors > 2) throw new Error("模型协议纠正次数耗尽，本轮未完成");
              await queueFeedback(`${invalid}。请遵守执行协议重新生成；被拒绝响应中的工具没有执行。`, raw);
              response.push({ type: "done", reason: "stop", message: { ...message, content: [], stopReason: "stop" } });
              return response;
            }
            if (parsed) {
              if (["progress", "status"].includes(parsed.type) && !toolCalls.length && ++idleProgress >= 3)
                throw new Error("模型连续三次未推进，本轮未完成");
              if (parsed.type === "final") finalText = parsed.text;
              if (parsed.type === "result") {
                const identity = parsed.text.trim();
                if (resultTexts.has(identity)) {
                  if (++idleProgress >= 3) throw new Error("模型连续重复阶段性成果，本轮未完成");
                } else {
                  resultTexts.add(identity);
                  idleProgress = 0;
                }
              }
              await request?.log.append({ type: "text_snapshot", requestId: request.id, modelStepId,
                textSegmentId, contentKind: parsed.type, text: parsed.text, protocolVersion: parsed.type === "progress" ? "json-text-v1" : OUTPUT_PROTOCOL_VERSION });
              await request?.log.append({ type: "text_finalized", requestId: request.id, modelStepId,
                textSegmentId, contentKind: parsed.type, text: parsed.text, protocolVersion: parsed.type === "progress" ? "json-text-v1" : OUTPUT_PROTOCOL_VERSION });
              await request?.onText?.(textSegmentId);
              if (parsed.type !== "final" && !toolCalls.length)
                await queueFeedback(`上一条输出是 ${parsed.type}，请继续实际操作，或用 final 提交答案、阻碍或澄清问题。`);
            }
            for (const part of toolCalls) await request?.log.append({ type: "tool_call", requestId: request.id,
              toolCallId: part.id, toolName: part.name, args: part.arguments });
            response.push({ type: "done", reason: message.stopReason, message });
            return response;
          }
          throw new Error("模型上下文溢出重试失败");
        } catch (error) {
          projectionFailure ??= error instanceof Error ? error : new Error(String(error));
          const response = createAssistantMessageEventStream();
          const failed = assistantText("", selected);
          failed.stopReason = "error"; failed.errorMessage = projectionFailure.message;
          response.push({ type: "error", reason: "error", error: failed });
          return response;
        }
      };
      session.agent.toolExecution = "sequential";
      if (request) {
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
        session.agent.subscribe(async (event) => {
          if (event.type !== "tool_execution_end") return;
          try {
            const events = await request.log.read();
            if (events.some((e) => e.type === "tool_result" && e.requestId === request.id && e.toolCallId === event.toolCallId)) return;
            if (!events.some((e) => (e.type === "tool_dispatch" || e.type === "tool_blocked") &&
              e.requestId === request.id && e.toolCallId === event.toolCallId))
              await request.log.append({ type: "tool_blocked", requestId: request.id,
                toolCallId: event.toolCallId, toolName: event.toolName });
            await recordResult(event.toolCallId, event.toolName,
              { ...event.result, isError: event.isError }, events.findLast((e) => e.toolCallId === event.toolCallId && e.args)?.args);
          } catch (error) {
            logFailure = error instanceof Error ? error : new Error(String(error));
            session.agent.abort();
          }
        });
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
        try { await session.prompt(current.text, { images: current.images }); }
        catch (error) { throw logFailure ?? projectionFailure ?? error; }
        if (logFailure) throw logFailure;
        if (projectionFailure) throw projectionFailure;
        const last = session.messages.at(-1);
        if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
          throw new Error("模型调用失败");
        }
        if (finalText === undefined) throw new Error("模型未提交最终答复，本轮未完成");
        return finalText;
      } finally { session.dispose(); }
    },
    async close(): Promise<void> { await tinyfish?.close(); },
  };
}
