import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry,
  SessionManager, SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "./app.js";
import type { Request } from "./app.js";
import { connectTinyfish } from "./tinyfish.js";

export async function createPiAgent(options: {
  dataDir: string;
  promptFile: string;
  deepseekKey: string;
  tinyfishKey?: string;
  modelBaseUrl?: string;
  tinyfishUrl?: string;
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
  const model = options.modelBaseUrl ? { ...defaultModel, baseUrl: options.modelBaseUrl } : defaultModel;
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
      for (const message of messages.slice(0, -1)) {
        if (message.role === "user") {
          manager.appendMessage({ role: "user", content: message.text, timestamp: Date.now() });
        } else {
          manager.appendMessage({
            role: "assistant", content: [{ type: "text", text: message.text }],
            api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop", timestamp: Date.now(),
          });
        }
      }
      const { session } = await createAgentSession({
        cwd: options.dataDir, agentDir: options.dataDir,
        authStorage, modelRegistry: ModelRegistry.create(authStorage),
        settingsManager, resourceLoader: loader, model, thinkingLevel: "off",
        tools: ["read", "write", "edit", "ls", "find", "grep", ...(tinyfish ? ["web_search", "web_fetch"] : [])],
        customTools: tinyfish?.tools ?? [], sessionManager: manager,
      });
      let logFailure: Error | undefined;
      if (request) {
        session.agent.toolExecution = "sequential";
        const originalBefore = session.agent.beforeToolCall;
        const originalAfter = session.agent.afterToolCall;
        const recordedResults = new Set<string>();
        let step = 0;
        const recordResult = async (toolCallId: string, toolName: string, result: {
          content: unknown; details: unknown; isError: boolean;
        }) => {
          let archive: Awaited<ReturnType<Request["log"]["archive"]>> | undefined;
          let archiveError: string | undefined;
          try { archive = await request.log.archive(result); }
          catch (error) { archiveError = String(error); }
          await request.log.append({ type: "tool_result", requestId: request.id,
            toolCallId, toolName, isError: result.isError,
            ...(archive ? { archive } : { result, archiveError }) });
          recordedResults.add(toolCallId);
          return archive;
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
          let archive: Awaited<ReturnType<Request["log"]["archive"]>> | undefined;
          try {
            archive = await recordResult(context.toolCall.id, context.toolCall.name, result);
          } catch (error) {
            logFailure = error instanceof Error ? error : new Error(String(error));
            session.agent.abort();
            return { content: [{ type: "text", text: "工具结果未能写入运行日志；本轮已停止。" }], terminate: true };
          }
          if (!archive || request.log.isArchiveRead(context.toolCall.name, context.args) ||
            JSON.stringify(result).length / 4 <= 2048) return previous;
          return { content: [{ type: "text", text: `工具结果已归档。工具：${context.toolCall.name}；路径：${archive.path}；字节数：${archive.bytes}；SHA-256：${archive.sha256}。可用 read 按 offset/limit 分段读取。` }], details: {} };
        };
        session.agent.subscribe(async (event) => {
          if (logFailure) return;
          try {
            if (event.type === "turn_start") {
              step++;
              await request.log.append({ type: "model_step_started", requestId: request.id, step });
            } else if (event.type === "turn_end") {
              await request.log.append({ type: "model_step_completed", requestId: request.id, step,
                stopReason: event.message.role === "assistant" ? event.message.stopReason : undefined });
            } else if (event.type === "tool_execution_start") {
              await request.log.append({ type: "tool_call", requestId: request.id,
                toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
            } else if (event.type === "tool_execution_end" && !recordedResults.has(event.toolCallId)) {
              const result = { content: event.result.content, details: event.result.details, isError: event.isError };
              await recordResult(event.toolCallId, event.toolName, result);
            } else if (event.type === "message_end" && event.message.role === "assistant") {
              await request.log.append({ type: "model_message", requestId: request.id,
                step, message: event.message });
            }
          } catch (error) {
            logFailure = error instanceof Error ? error : new Error(String(error));
            session.agent.abort();
          }
        });
      }
      try {
        await session.prompt(current.text);
        if (logFailure) throw logFailure;
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
