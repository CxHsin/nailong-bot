import { randomUUID, createHash } from "node:crypto";
import { createAssistantMessageEventStream, isContextOverflow } from "@mariozechner/pi-ai";
import type { Api, Model, Message, Usage, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Request } from "../application/app-types.js";
import { createContextProjection } from "../context/context-budget.js";
import { assistantText, stableSystemPrompt } from "./model-message.js";
import { createToolPathPolicy } from "./tool-path-policy.js";
import { OUTPUT_PROTOCOL_VERSION, parseStructuredText, previewStructuredText, readOutputFrames, normalizeOutputWhitespace, recoverFinalEnvelope } from "./output-protocol.js";
import { composeMemory, composeMemoryLive, memoryBudget, recallMemory, type MemoryBudget } from "../application/memory-context.js";
import type { createMemoryProjection } from "../memory/projection.js";
import { estimateInput, modelInputBudget, fedContextRatio } from "../context/input-budget.js";
import { recordModelUsage } from "./model-usage.js";
import { projectProviderContext, projectNativeContext } from "../context/provider-aware.js";
import { memoryExclusions, eventIdentity } from "../runtime/memory-facts.js";
import { PLAIN_TEXT_PROTOCOL } from "./progress-prompt.js";

function deepseekCacheOptions(options?: SimpleStreamOptions): SimpleStreamOptions {
  return { ...options, cacheRetention: "short", maxRetries: 0, onPayload: async (payload, model) => {
    const customized = await options?.onPayload?.(payload, model);
    const result = customized ?? payload;
    if (model.provider !== "deepseek" || !result || typeof result !== "object") return result;
    const clean = { ...result } as Record<string, unknown>;
    delete clean.prompt_cache_key;
    delete clean.prompt_cache_retention;
    delete clean.cache_control;
    return clean;
  } };
}

export async function attachExecution(session: AgentSession, model: Model<Api>, options: { dataDir: string; promptFile: string; contextBudgetRatio?: number; modelBudgetRatios?: Record<string, number>; memoryBudget?: MemoryBudget; now?: () => Date; outputProtocol?: "json-text-v2" | "plain-text-v3" }, botPrompt: string, systemPrompt: string, request?: Request, memory?: ReturnType<typeof createMemoryProjection>) {
  const plain = options.outputProtocol !== "json-text-v2" && !request?.onText;
  const protocolVersion = plain ? PLAIN_TEXT_PROTOCOL : OUTPUT_PROTOCOL_VERSION;
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
    protocolVersion, botPrompt, systemPrompt, botPromptVersion: request.botPromptVersion ?? createHash("sha256").update(botPrompt).digest("hex"),
    systemPromptHash: createHash("sha256").update(systemPrompt).digest("hex") });
  const providerStream = session.agent.streamFn;
  const identityEvents = request?.conversationId ? await request.log.read() : [];
  const resetIndex = identityEvents.findLastIndex((event) => event.type === "conversation_reset" || event.type === "reset");
  const projectionIdentity = request?.conversationId ? projectProviderContext({ conversationId: request.conversationId,
    capabilities: { provider: model.provider, model: model.id, promptProfile: createHash("sha256").update(JSON.stringify({ systemPrompt, tools: session.agent.state.tools,
      reset: resetIndex < 0 ? "initial" : eventIdentity(identityEvents[resetIndex]!, resetIndex), excluded: [...memoryExclusions(identityEvents)].sort() })).digest("hex"),
      reasoningReplay: false, promptCaching: true, images: true, compaction: true, appendConfigurationUpdates: false }, items: [] }) : undefined;
  if (projectionIdentity) session.agent.sessionId = projectionIdentity.cacheKey;
  const user = request && (await request.log.read()).find((e) => e.requestId === request.id && e.role === "user");
  const recalled = memory && request ? await recallMemory(memory, request, String(user?.originalText ?? user?.text ?? "")) : undefined;
  const budgetRatio = request?.contextBudgetBoost ? fedContextRatio(modelInputBudget(model, options.contextBudgetRatio, options.modelBudgetRatios).ratio) : options.contextBudgetRatio;
  const budgetRatios = request?.contextBudgetBoost ? undefined : options.modelBudgetRatios;
  const sourceDigestForReplay = () => createHash("sha256").update(JSON.stringify({ systemPrompt, tools: session.agent.state.tools, protocolVersion })).digest("hex");
  const projection = request && createContextProjection({ log: request.log, dataDir: options.dataDir, requestId: request.id,
    conversationId: request.conversationId, structured: !plain,
    ratio: budgetRatio, ratios: budgetRatios,
    cacheIdentity: sourceDigestForReplay(),
    signal: request?.signal,
    onCheckpointValidated: () => request?.onProgress?.({ type: "text", segmentId: `${request.id}:checkpoint`, kind: "status", text: "历史摘要已生成，结构检查通过。", actionState: "completed", finalized: true, formal: false, source: "execution" }),
    onRestoreProgress: (checked, total) => request?.onProgress?.({ type: "text", segmentId: `${request.id}:history`, kind: "status", text: `正在恢复历史记录：${checked}/${total} 条已检查。`, actionState: "started", finalized: true, formal: false, source: "execution" }),
    summarize: async (context, maxTokens) => {
      request?.onProgress?.({ type: "text", segmentId: `${request.id}:checkpoint`, kind: "status", text: "正在整理历史摘要……", actionState: "started", finalized: true, formal: false, source: "execution" });
      const callId = randomUUID();
      await request?.log.append({ type: "model_call_started", requestId: request.id, callId, purpose: "summary", provider: model.provider, model: model.id });
      const stream = await providerStream(model, projectNativeContext(context, model), deepseekCacheOptions({ maxTokens, signal: session.agent.signal,
        ...(model.provider === "xh" ? { reasoning: "low" as const } : {}) }));
      let initialUsage: Usage | undefined;
      for await (const event of stream) {
        if (event.type === "start") initialUsage = event.partial.usage;
        if (event.type === "text_delta") {
          const partial = event.partial.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
          request?.onProgress?.({ type: "text", segmentId: `${request.id}:checkpoint`, kind: "status", text: `正在生成历史摘要，已收到 ${Array.from(partial).length} 字摘要，完成后核验。`, actionState: "started", finalized: false, formal: false, source: "execution" });
        }
      }
      const response = await stream.result();
      await recordModelUsage(request, callId, "summary", response, initialUsage);
      if (response.stopReason !== "stop") throw new Error("历史摘要生成未完整结束");
      return response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    },
  });
  let snapshot = request?.conversationId ? (await request.log.read()).find((event) => event.type === "context_input_snapshot" && event.requestId === request.id) : undefined;
  session.agent.streamFn = async (selected, context, streamOptions) => {
    let activePreview: string | undefined;
    try {
      if (request?.conversationId) context = { ...context, systemPrompt: stableSystemPrompt(systemPrompt, options.dataDir) };
      if (projectionFailure) throw projectionFailure;
      dispatchedThisStep = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const inputBudget = modelInputBudget(selected, budgetRatio, budgetRatios).budget;
        const date: Message = { role: "user", timestamp: 0, content: `运行层当前日期（背景资料）：${(options.now?.() ?? new Date()).toISOString().slice(0, 10)}` };
        const reserve = snapshot ? 0 : (recalled?.candidates.length ? memoryBudget(inputBudget, options.memoryBudget) : 0) +
          (request?.conversationId ? estimateInput({ messages: [date] }) - estimateInput({ messages: [] }) : 0);
        const phase = (id: string, text: string, actionState: "started" | "completed" | "failed") => request?.onProgress?.({ type: "text", segmentId: `${request.id}:${id}`, kind: "status", text, actionState, finalized: true, formal: false, source: "execution" });
        phase("history", "正在恢复历史上下文……", "started");
        const restoreStarted = performance.now();
        const result = projection ? await projection.project(selected, context, attempt === 1, reserve) :
          { context, maxTokens: selected.maxTokens, sourceIds: [] as string[] };
        const restoreMs = performance.now() - restoreStarted;
        phase("history", `历史上下文已恢复，${result.context.messages.length} 条消息。`, "completed");
        phase("memory-select", "正在筛选候选记忆……", "started");
        const selectStarted = performance.now();
        let combined = snapshot ? { context: result.context, shown: snapshot.shown as ReturnType<typeof composeMemory>["shown"], tokens: Number(snapshot.tokens), quotes: [] } :
          await composeMemoryLive([result.context, result.sourceIds, recalled?.candidates ?? [], recalled?.candidates.length ? memoryBudget(inputBudget, options.memoryBudget) : 0, String(user?.text ?? "")], (counts) => phase("memory-select", `已检查 ${counts.checked}/${counts.total} 条候选，选入 ${counts.loaded} 段引用。`, "started"), request?.signal);
        const selectMs = performance.now() - selectStarted;
        phase("memory-select", snapshot ? "已复用本轮记忆快照。" : `筛选完成，实际选入 ${combined.quotes.length} 段引用；重复或超预算内容未加入。`, "completed");
        const loadStarted = performance.now();
        if (request?.conversationId && !snapshot) {
          const currentIndex = combined.context.messages.findLastIndex((message) => message.role === "user");
          const memoryMessage = combined.quotes.length ? combined.context.messages[currentIndex - 1] : undefined;
          const supplemental = [date, ...(memoryMessage ? [memoryMessage] : [])];
          const messages = [...combined.context.messages];
          messages.splice(memoryMessage ? currentIndex - 1 : currentIndex, 0, date);
          combined = { ...combined, context: { ...combined.context, messages } };
          snapshot = { type: "context_input_snapshot", at: new Date().toISOString(), messages: supplemental,
            shown: combined.shown, tokens: combined.tokens,
            memoryNodeIds: combined.quotes.flatMap((quote) => { const reference = quote as { nodeId: string; associationPaths?: string[][] };
              return [reference.nodeId, ...(reference.associationPaths?.flat() ?? [])]; }) };
          const { at: _at, ...storedSnapshot } = snapshot;
          await request.log.append({ ...storedSnapshot, requestId: request.id });
        }
        if (request && combined.quotes.length) phase("memory-ready", `已加载 ${combined.quotes.length} 段记忆引用。`, "completed");
        combined = { ...combined, context: projectNativeContext(combined.context, selected) };
        if (estimateInput(combined.context) > inputBudget) throw new Error("上下文超过预算");
        const loadMs = performance.now() - loadStarted;
        await request?.log.append({ type: "context_phase_timing", requestId: request.id, restoreMs, selectMs, loadMs, contextPolicy: "exclude" });
        const modelStepId = randomUUID();
        const textSegmentId = randomUUID();
        activePreview = textSegmentId;
        if (++step > 128) throw new Error("模型超过本轮执行步数上限");
        await request?.log.append({ type: "model_step_started", requestId: request.id, step, modelStepId, purpose: "execution", provider: selected.provider, model: selected.id,
          systemPrompt: result.context.systemPrompt, cacheKey: projectionIdentity?.cacheKey,
          stablePrefixKey: createHash("sha256").update(JSON.stringify({ system: result.context.systemPrompt, tools: result.context.tools })).digest("hex") });
        request?.onProgress?.({ type: "text", segmentId: `${request.id}:input-ready`, kind: "status", text: "上下文已准备好，等待模型输出……", actionState: "started", finalized: true, formal: false, source: "execution" });
        const source = await providerStream(selected, combined.context, deepseekCacheOptions({ ...streamOptions,
          maxTokens: Math.max(1, Math.min(result.maxTokens, selected.contextWindow - estimateInput(combined.context))) }));
        let producedOutput = false;
        let initialUsage: Usage | undefined;
        let lastPreview = "";
        let lastPreviewAt = -Infinity;
        let lastValidatedPrefix = "";
        for await (const event of source) {
          if (event.type === "start") initialUsage = event.partial.usage;
          if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") producedOutput = true;
          if (event.type === "text_delta" && request) {
            const rawPreview = event.partial.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
            let preview: ReturnType<typeof previewStructuredText>;
            let validatedPrefix = false;
            let prefixChanged = false;
            if (plain) preview = { type: "progress", text: rawPreview };
            else try {
              const frames = readOutputFrames(rawPreview);
              const partial = previewStructuredText(frames.rest);
              if (frames.prefix && (!partial || partial.type === frames.prefix.type)) {
                preview = { ...frames.prefix, text: frames.prefix.text + (partial?.text ?? "") };
                validatedPrefix = frames.framed;
                if (frames.prefix.text && frames.prefix.text !== lastValidatedPrefix) {
                  if (request.onText) await request.log.append({ type: "text_validated_prefix", requestId: request.id,
                    modelStepId, textSegmentId, text: frames.prefix.text, contentKind: frames.prefix.type });
                  lastValidatedPrefix = frames.prefix.text;
                  prefixChanged = true;
                }
              } else preview = frames.output ?? partial;
            } catch { /* Invalid protocol cannot publish new text or dispatch tools. */ }
            // Preview at most every 100 ms, but publish complete validated frames immediately.
            if (preview && preview.text !== lastPreview && (prefixChanged || performance.now() - lastPreviewAt >= 100)) {
              if (request.onText) await request.log.append({ type: "text_snapshot", requestId: request.id, modelStepId,
                textSegmentId, contentKind: preview.type, text: preview.text,
                protocolVersion: OUTPUT_PROTOCOL_VERSION, provisional: true, validatedPrefix });
              lastPreview = preview.text;
              lastPreviewAt = performance.now();
              request.onProgress?.({ type: "text", segmentId: textSegmentId, kind: preview.type, text: preview.text, finalized: false });
              await request.onText?.(textSegmentId);
            }
          }
        }
        const message = await source.result();
        await recordModelUsage(request, modelStepId, "execution", message, initialUsage);
        if (request && recalled?.snapshotId && message.stopReason !== "error" && message.stopReason !== "aborted")
          await request.log.append({ type: "memory_presented", requestId: request.id,
            modelStepId, snapshotId: recalled.snapshotId, shown: combined.shown, tokens: combined.tokens, budget: reserve });
        await request?.log.append({ type: "model_message", requestId: request.id, step,
          modelStepId, protocolVersion, message });
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
        if (plain) {
          if (!raw.trim() && !toolCalls.length) throw new Error("模型没有提交答复或工具调用");
          if (raw.trim()) {
            const kind = toolCalls.length ? "progress" : "final";
            await request?.log.append({ type: "text_finalized", requestId: request.id, modelStepId,
              textSegmentId, contentKind: kind, text: raw, protocolVersion, source: "execution" });
            request?.onProgress?.({ type: "text", segmentId: textSegmentId, kind, text: raw, finalized: true, formal: kind !== "final", source: "execution" });
            if (kind === "final") finalText = raw;
          }
          for (const part of toolCalls) await request?.log.append({ type: "tool_call", requestId: request.id,
            toolCallId: part.id, toolName: part.name, args: part.arguments });
          const response = createAssistantMessageEventStream();
          response.push({ type: "done", reason: message.stopReason, message });
          return response;
        }
        let parsed: ReturnType<typeof parseStructuredText> | undefined;
        let invalid: string | undefined;
        let repairedEnvelope = false;
        try {
          if (raw) parsed = parseStructuredText(raw);
          else if (!toolCalls.length) throw new Error("缺少结构化文字和工具调用");
          if (parsed?.type === "final" && toolCalls.length) throw new Error("final 不允许同时调用工具");
        } catch (error) {
          const recovered = recoverFinalEnvelope(raw, message.stopReason, toolCalls.length > 0);
          if (recovered) { parsed = recovered; repairedEnvelope = true; }
          else invalid = error instanceof Error ? error.message : String(error);
        }
        await request?.log.append({ type: "protocol_validated", requestId: request.id, modelStepId,
          protocolVersion: OUTPUT_PROTOCOL_VERSION, valid: !invalid, error: invalid,
          normalizedWhitespace: !invalid && normalizeOutputWhitespace(raw) !== raw, repairedEnvelope });
        const response = createAssistantMessageEventStream();
        if (invalid) {
          await request?.log.append({ type: "text_discarded", requestId: request.id, modelStepId, textSegmentId, reason: invalid });
          request?.onProgress?.({ type: "discard", segmentId: textSegmentId });
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
          request?.onProgress?.({ type: "text", segmentId: textSegmentId, kind: parsed.type, text: parsed.text, finalized: true });
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
      if (activePreview) request?.onProgress?.({ type: "discard", segmentId: activePreview });
      projectionFailure ??= error instanceof Error ? error : new Error(String(error));
      const response = createAssistantMessageEventStream();
      const failed = assistantText("", selected);
      failed.stopReason = "error"; failed.errorMessage = projectionFailure.message;
      response.push({ type: "error", reason: "error", error: failed });
      return response;
    }
  };
  return { failure: () => projectionFailure, finalText: () => finalText };
}
