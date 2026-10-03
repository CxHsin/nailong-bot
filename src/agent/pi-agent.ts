import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry,
  SessionManager, SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "../application/app-types.js";
import type { Request } from "../application/app-types.js";
import { connectTinyfish } from "./tinyfish.js";
import { assistantText } from "./model-message.js";
import { attachToolRecording } from "./tool-recording.js";
import { createBoundedRead } from "./archive-read.js";
import { createRuntimeLog } from "../runtime/runtime-log.js";
import { attachExecution } from "./execution.js";
import { EXECUTION_PROMPT, protocolText } from "./output-protocol.js";
import { createMemoryProjection, type MemoryMode } from "../memory/projection.js";
import { memoryTools } from "../memory/tools.js";
import type { MemoryBudget } from "../application/memory-context.js";
import { createEmbeddingClient, type EmbeddingConfig } from "../memory/embedding.js";
import { memoryDynamics, type MemoryDynamics } from "../memory/dynamics.js";
import { recallConfig, type RecallConfig } from "../memory/recall.js";
import { memoryBudget } from "../application/memory-context.js";
import { modelInputBudget } from "../context/input-budget.js";
import { createMemoryBootstrap } from "../application/memory-bootstrap.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";

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
  memoryBudget?: MemoryBudget;
  embedding?: EmbeddingConfig;
  memoryDynamics?: Partial<MemoryDynamics>;
  memoryNow?: () => number;
  memoryRecall?: Partial<RecallConfig>;
  memoryBootstrap?: boolean;
  memoryMode?: MemoryMode;
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
  memoryBudget(modelInputBudget(model, options.contextBudgetRatio, options.modelBudgetRatios).budget, options.memoryBudget);
  memoryDynamics(options.memoryDynamics); recallConfig(options.memoryRecall);
  const authStorage = AuthStorage.create(join(options.dataDir, "auth.json"));
  authStorage.setRuntimeApiKey("deepseek", options.deepseekKey);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const embedding = options.embedding ? createEmbeddingClient(options.dataDir, options.embedding) : undefined;
  const bootstrap = createMemoryBootstrap({ dataDir: options.dataDir, model, embedding, dynamics: options.memoryDynamics, recall: options.memoryRecall,
    budget: options.memoryBudget, ratio: options.contextBudgetRatio, ratios: options.modelBudgetRatios });
  return {
    memoryVector: (text: string) => embedding?.cached(text),
    purgeEmbeddingCache: () => embedding?.purge(),
    initializeMemory: (log: RuntimeLog, userId: number) => options.memoryMode === "dense" ? Promise.resolve() : bootstrap.start(log, userId),
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
      const userId = request ? (await request.log.read()).find((e) => e.requestId === request.id && e.role === "user")?.chatId : undefined;
      const memory = request && typeof userId === "number" ? createMemoryProjection({ log: request.log, dataDir: options.dataDir, userId, embedding, dynamics: options.memoryDynamics, now: options.memoryNow, recall: options.memoryRecall, mode: options.memoryMode }) : undefined;
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
        tools: ["read", "write", "edit", "ls", "find", "grep", ...(memory ? ["memory_search", "memory_read"] : []), ...(tinyfish ? ["web_search", "web_fetch"] : [])],
        customTools: [createBoundedRead(options.dataDir, request?.log ?? createRuntimeLog(options.dataDir)),
          ...(memory && request ? memoryTools(memory, request.id) : []),
          ...(tinyfish?.tools ?? [])], sessionManager: manager,
      });
      const execution = await attachExecution(session, model, options, botPrompt, systemPrompt, request, memory);
      if (request && typeof userId === "number" && options.memoryBootstrap !== false && options.memoryMode !== "dense")
        void bootstrap.start(request.log, userId, request.id, { systemPrompt: session.agent.state.systemPrompt, messages: [], tools: session.agent.state.tools });
      session.agent.toolExecution = "sequential";
      const toolFailure = request ? attachToolRecording(session.agent, request) : () => undefined;
      try {
        try { await session.prompt(current.text, { images: current.images }); }
        catch (error) { throw toolFailure() ?? execution.failure() ?? error; }
        if (toolFailure()) throw toolFailure();
        if (execution.failure()) throw execution.failure();
        const last = session.messages.at(-1);
        if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
          throw new Error("模型调用失败");
        }
        if (execution.finalText() === undefined) throw new Error("模型未提交最终答复，本轮未完成");
        return execution.finalText()!;
      } finally { session.dispose(); }
    },
    async close(): Promise<void> { await bootstrap.close(); await embedding?.close(); await tinyfish?.close(); },
  };
}
