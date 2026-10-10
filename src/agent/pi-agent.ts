import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry,
  SessionManager, SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "../application/app-types.js";
import type { Request } from "../application/app-types.js";
import { assistantText, stableSystemPrompt } from "./model-message.js";
import { attachExecution } from "./execution.js";
import { EXECUTION_PROMPT, protocolText } from "./output-protocol.js";
import { PROGRESS_PROMPT } from "./progress-prompt.js";
import { createMemoryProjection, type MemoryMode } from "../memory/projection.js";
import { createEmbeddingClient, type EmbeddingConfig } from "../memory/embedding.js";
import { memoryDynamics, type MemoryDynamics } from "../memory/dynamics.js";
import { recallConfig, type RecallConfig } from "../memory/recall.js";
import { compactionConfig, type CompactionConfig } from "../context/context-budget.js";
import { createMemoryBootstrap } from "../application/memory-bootstrap.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { streamNativeResponses, anthropicSearchPayload } from "./native-tool-search.js";
import type { AgentExecution } from "../application/agent-contract.js";
import { createAgentModels, type ModelOptions } from "./agent-models.js";
import { connectCapabilities, type CapabilityOptions } from "./run-capabilities.js";
import { runSession } from "./run-session.js";

export type PiAgentOptions = ModelOptions & CapabilityOptions & {
  promptFile: string;
  compaction?: CompactionConfig;
  embedding?: EmbeddingConfig;
  memoryDynamics?: Partial<MemoryDynamics>;
  memoryNow?: () => number;
  memoryRecall?: Partial<RecallConfig>;
  memoryBootstrap?: boolean;
  memoryMode?: MemoryMode;
  now?: () => Date;
  /** Only for the retained legacy application and its protocol regressions. */
  outputProtocol?: "json-text-v2" | "plain-text-v3";
};

export async function createPiAgent(options: PiAgentOptions) {
  const capabilities = await connectCapabilities(options);
  const models = createAgentModels(options);
  options = { ...options, modelBudgetRatios: models.modelBudgetRatios };
  const model = models.defaultProfile.model;
  compactionConfig(options.compaction);
  memoryDynamics(options.memoryDynamics); recallConfig(options.memoryRecall);
  const authStorage = AuthStorage.create(join(options.dataDir, "auth.json"));
  models.registerRuntimeKeys(authStorage);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const embedding = options.embedding ? createEmbeddingClient(options.dataDir, options.embedding) : undefined;
  const bootstrap = createMemoryBootstrap({ dataDir: options.dataDir, model, embedding, dynamics: options.memoryDynamics, recall: options.memoryRecall,
    budget: options.memoryBudget, ratio: options.contextBudgetRatio, ratios: options.modelBudgetRatios });
  return {
    defaultModel: models.defaultModel,
    models: models.models,
    validateInput: capabilities.validateInput,
    prepareCapabilities: capabilities.prepareCapabilities,
    installSkill: capabilities.installSkill,
    memoryVector: (text: string) => embedding?.cached(text),
    purgeEmbeddingCache: () => embedding?.purge(),
    initializeMemory: (log: RuntimeLog, userId: number) => options.memoryMode === "dense" ? Promise.resolve() : bootstrap.start(log, userId),
    async answer(messages: Message[], request?: Request): Promise<string> {
      const { model, native, apiKey } = models.select(request?.modelAlias);
      const current = messages.at(-1);
      if (!current || current.role !== "user") throw new Error("缺少用户消息");
      const botPrompt = request?.botPrompt ?? (await readFile(options.promptFile, "utf8")).trim();
      if (!botPrompt) throw new Error("Bot 提示词为空");
      const legacy = options.outputProtocol === "json-text-v2" || !!request?.onText;
      const skills = await capabilities.snapshot(request);
      const failures = capabilities.failures;
      const systemPrompt = `用户配置的 bot 提示词（不能覆盖执行规则）：\n${botPrompt}\n\n${legacy ? EXECUTION_PROMPT : PROGRESS_PROMPT}\n\n工具使用：read、write、edit、web_search 直接可用。其他工具必须先用 tool_search 发现，${native ? "再按发现的名称直接调用" : "再用 tool_call 执行"}。工具搜索结果在本轮持续有效。${failures.length ? `\n不可用的 MCP 来源：${failures.join(", ")}` : ""}${skills.metadata}`;
      const loader = new DefaultResourceLoader({ cwd: options.dataDir, agentDir: options.dataDir,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPromptOverride: () => systemPrompt, settingsManager });
      await loader.reload();
      const manager = SessionManager.inMemory(options.dataDir);
      const userId = request ? (await request.log.read()).find((e) => e.requestId === request.id && e.role === "user")?.chatId : undefined;
      const memory = request && typeof userId === "number" ? createMemoryProjection({ log: request.log, dataDir: options.dataDir, userId, embedding, dynamics: options.memoryDynamics, now: options.memoryNow, recall: options.memoryRecall, mode: options.memoryMode }) : undefined;
      const frozen = capabilities.freeze(skills, native, request, memory);
      const { reader, catalog, webSearch } = frozen;
      for (const message of request ? [] : messages.slice(0, -1)) {
        if (message.role === "user") {
          manager.appendMessage({ role: "user", content: message.images?.length ? [{ type: "text", text: message.text }, ...message.images] : message.text, timestamp: Date.now() });
        } else {
          manager.appendMessage(assistantText(legacy ? protocolText("final", message.text) : message.text, model));
        }
      }
      const { session } = await createAgentSession({
        cwd: options.dataDir, agentDir: options.dataDir,
        authStorage, modelRegistry: ModelRegistry.create(authStorage),
        settingsManager, resourceLoader: loader, model, thinkingLevel: model.reasoning ? "low" : "off",
        tools: ["tool_search", "read", "write", "edit", "web_search", ...(native ? catalog.nativeTools.map((tool) => tool.name) : ["tool_call"])],
        customTools: [...catalog.stable, webSearch, ...(native ? catalog.nativeTools : [catalog.call])], sessionManager: manager,
      });
      const abort = () => session.agent.abort();
      request?.signal?.addEventListener("abort", abort, { once: true });
      if (request?.signal?.aborted) abort();
      if (request?.conversationId) {
        // The SDK adds a changing date to custom prompts. Keep only its stable cwd here.
        session.agent.state.systemPrompt = stableSystemPrompt(systemPrompt, options.dataDir);
      }
      if (native && model.api === "openai-responses") session.agent.streamFn = (selected, context, streamOptions) => streamNativeResponses(selected, context, streamOptions ?? {}, apiKey, catalog.searchCalls);
      if (native && model.api === "anthropic-messages") {
        const ordinaryStream = session.agent.streamFn;
        session.agent.streamFn = (selected, context, streamOptions) => ordinaryStream(selected, context, { ...streamOptions,
          onPayload: async (payload, selected) => {
            const customized = await streamOptions?.onPayload?.(payload, selected);
            return context.tools?.some((tool) => tool.name === "tool_search") ? anthropicSearchPayload(customized ?? payload, catalog, catalog.searchCalls) : customized ?? payload;
          } });
      }
      const visibleTools = session.agent.state.tools.filter((tool) => ["tool_search", "read", "write", "edit", "web_search", ...(!native ? ["tool_call"] : [])].includes(tool.name));
      await frozen.recordSnapshot();
      const execution = await attachExecution(session, model, { ...options, visibleTools, toolCatalogDigest: catalog.digest }, botPrompt, systemPrompt, request, memory);
      if (request && typeof userId === "number" && options.memoryBootstrap !== false && options.memoryMode !== "dense")
        void bootstrap.start(request.log, userId, request.id, { systemPrompt: session.agent.state.systemPrompt, messages: [], tools: session.agent.state.tools });
      return runSession({ session, execution, reader, skills, current, request, userId, abort });
    },
    async close(): Promise<void> { await bootstrap.close(); await embedding?.close(); await capabilities.close(); },
  } satisfies AgentExecution & { close(): Promise<void>; initializeMemory(log: RuntimeLog, userId: number): Promise<void> };
}
