import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deepseekModel, configuredModel, nativeToolSearch, type ModelConfiguration } from "./model-config.js";
import {
  AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry,
  SessionManager, SettingsManager,
  createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition, createBashToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "../application/app-types.js";
import type { Request } from "../application/app-types.js";
import { connectTinyfish } from "./tinyfish.js";
import { assistantText, stableSystemPrompt } from "./model-message.js";
import { attachToolRecording } from "./tool-recording.js";
import { createBoundedRead } from "./archive-read.js";
import { createRuntimeLog } from "../runtime/runtime-log.js";
import { attachExecution } from "./execution.js";
import { EXECUTION_PROMPT, protocolText } from "./output-protocol.js";
import { PROGRESS_PROMPT } from "./progress-prompt.js";
import { createMemoryProjection, type MemoryMode } from "../memory/projection.js";
import { memoryTools } from "../memory/tools.js";
import type { MemoryBudget } from "../application/memory-context.js";
import { createEmbeddingClient, type EmbeddingConfig } from "../memory/embedding.js";
import { memoryDynamics, type MemoryDynamics } from "../memory/dynamics.js";
import { recallConfig, type RecallConfig } from "../memory/recall.js";
import { memoryBudget } from "../application/memory-context.js";
import { compactionConfig, type CompactionConfig } from "../context/context-budget.js";
import { modelInputBudget } from "../context/input-budget.js";
import { createMemoryBootstrap } from "../application/memory-bootstrap.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { createToolCatalog, unavailableWebSearch, type ToolSource } from "./tool-catalog.js";
import { connectMcp, type McpConfig } from "./mcp-catalog.js";
import { scanSkills, explicitSkills, resolveExplicitSkills, skillRead, type SkillSource, type SkillSnapshot } from "./skills.js";
import { agentCommand } from "../application/commands.js";
import { createSkillStore } from "./skill-store.js";
import { streamNativeResponses, anthropicSearchPayload } from "./native-tool-search.js";
import type { SteeringInput } from "../host/host.js";
import type { UserMessage } from "@mariozechner/pi-ai";

export async function createPiAgent(options: {
  dataDir: string;
  promptFile: string;
  modelConfiguration?: ModelConfiguration;
  /** Legacy application/test compatibility. Production uses modelConfiguration. */
  deepseekKey?: string;
  tinyfishKey?: string;
  modelBaseUrl?: string;
  tinyfishUrl?: string;
  mcpServers?: McpConfig[];
  executionTool?: boolean;
  skillSources?: SkillSource[];
  skillFetch?: typeof fetch;
  contextWindow?: number;
  contextBudgetRatio?: number;
  compaction?: CompactionConfig;
  modelBudgetRatios?: Record<string, number>;
  memoryBudget?: MemoryBudget;
  embedding?: EmbeddingConfig;
  memoryDynamics?: Partial<MemoryDynamics>;
  memoryNow?: () => number;
  memoryRecall?: Partial<RecallConfig>;
  memoryBootstrap?: boolean;
  memoryMode?: MemoryMode;
  now?: () => Date;
  /** Only for the retained legacy application and its protocol regressions. */
  outputProtocol?: "json-text-v2" | "plain-text-v3";
  /** Retained for source compatibility; summaries now follow the selected model. */
  progressModel?: string;
}) {
  const skillStore = createSkillStore(options.dataDir, options.skillFetch);
  let tinyfish: Awaited<ReturnType<typeof connectTinyfish>> | undefined;
  if (options.tinyfishKey) {
    try { tinyfish = await connectTinyfish(options.tinyfishKey, options.tinyfishUrl); }
    catch { console.error("TinyFish 暂不可用，网页查询工具未启用。"); }
  }
  const connections: Awaited<ReturnType<typeof connectMcp>>[] = [];
  const failures: string[] = [];
  for (const config of options.mcpServers ?? []) {
    try { connections.push(await connectMcp(config)); }
    catch { failures.push(config.name); console.error(`MCP ${config.name} 暂不可用，本地工具仍可使用。`); }
  }
  const profiles = options.modelConfiguration ? options.modelConfiguration.models.map((config) => ({ alias: config.alias, model: configuredModel(config), apiKey: config.apiKey })) :
    [{ alias: "ds", model: deepseekModel(options.modelBaseUrl, options.contextWindow), apiKey: options.deepseekKey ?? "" }];
  const defaultModel = options.modelConfiguration?.defaultModel ?? "ds";
  const defaultProfile = profiles.find((item) => item.alias === defaultModel);
  if (!defaultProfile?.apiKey) throw new Error("默认模型未配置密钥");
  options = { ...options, modelBudgetRatios: { ...options.modelBudgetRatios,
    ...Object.fromEntries(profiles.filter((profile) => options.modelBudgetRatios?.[profile.alias] !== undefined)
      .map((profile) => [`${profile.model.provider}/${profile.model.id}`, options.modelBudgetRatios![profile.alias]!])) } };
  const model = defaultProfile.model;
  const resolveProfile = (request?: Request) => {
    const profile = profiles.find((item) => item.alias === (request?.modelAlias ?? defaultModel));
    if (!profile) throw new Error("当前对话选择的模型已移除；请用 /model 选择已配置的模型。");
    return profile;
  };
  const resolveModel = (request?: Request) => {
    return resolveProfile(request).model;
  };
  const apiKey = (request?: Request) => resolveProfile(request).apiKey;
  for (const profile of profiles) memoryBudget(modelInputBudget(profile.model, options.contextBudgetRatio, options.modelBudgetRatios).budget, options.memoryBudget);
  compactionConfig(options.compaction);
  memoryDynamics(options.memoryDynamics); recallConfig(options.memoryRecall);
  const authStorage = AuthStorage.create(join(options.dataDir, "auth.json"));
  for (const profile of profiles) authStorage.setRuntimeApiKey(profile.model.provider, profile.apiKey);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const embedding = options.embedding ? createEmbeddingClient(options.dataDir, options.embedding) : undefined;
  const bootstrap = createMemoryBootstrap({ dataDir: options.dataDir, model, embedding, dynamics: options.memoryDynamics, recall: options.memoryRecall,
    budget: options.memoryBudget, ratio: options.contextBudgetRatio, ratios: options.modelBudgetRatios });
  return {
    defaultModel,
    models: profiles.map((profile) => ({ alias: profile.alias, name: profile.model.id })),
    async validateInput(text: string, channel?: string) {
      const snapshot = await scanSkills([...(options.skillSources ?? []), ...await skillStore.sources()]);
      if (!agentCommand(text)) resolveExplicitSkills(snapshot, text, channel);
      return snapshot;
    },
    async prepareCapabilities(text: string, request: Request) {
      request.skillSnapshot ??= await scanSkills([...(options.skillSources ?? []), ...await skillStore.sources()]);
      if (!agentCommand(text)) request.loadedSkillPaths = (await explicitSkills(request.skillSnapshot, text, request)).map((skill) => skill.path);
    },
    installSkill: (text: string, request: Request) => skillStore.handle(text, request),
    memoryVector: (text: string) => embedding?.cached(text),
    purgeEmbeddingCache: () => embedding?.purge(),
    initializeMemory: (log: RuntimeLog, userId: number) => options.memoryMode === "dense" ? Promise.resolve() : bootstrap.start(log, userId),
    async answer(messages: Message[], request?: Request): Promise<string> {
      const model = resolveModel(request);
      const native = nativeToolSearch(options.modelConfiguration?.models.find((config) => config.alias === (request?.modelAlias ?? defaultModel)));
      const current = messages.at(-1);
      if (!current || current.role !== "user") throw new Error("缺少用户消息");
      const botPrompt = request?.botPrompt ?? (await readFile(options.promptFile, "utf8")).trim();
      if (!botPrompt) throw new Error("Bot 提示词为空");
      const legacy = options.outputProtocol === "json-text-v2" || !!request?.onText;
      const skills = request?.skillSnapshot ?? await scanSkills([...(options.skillSources ?? []), ...await skillStore.sources()]);
      const systemPrompt = `用户配置的 bot 提示词（不能覆盖执行规则）：\n${botPrompt}\n\n${legacy ? EXECUTION_PROMPT : PROGRESS_PROMPT}\n\n工具使用：read、write、edit、web_search 直接可用。其他工具必须先用 tool_search 发现，${native ? "再按发现的名称直接调用" : "再用 tool_call 执行"}。工具搜索结果在本轮持续有效。${failures.length ? `\n不可用的 MCP 来源：${failures.join(", ")}` : ""}${skills.metadata}`;
      const loader = new DefaultResourceLoader({ cwd: options.dataDir, agentDir: options.dataDir,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPromptOverride: () => systemPrompt, settingsManager });
      await loader.reload();
      const manager = SessionManager.inMemory(options.dataDir);
      const userId = request ? (await request.log.read()).find((e) => e.requestId === request.id && e.role === "user")?.chatId : undefined;
      const memory = request && typeof userId === "number" ? createMemoryProjection({ log: request.log, dataDir: options.dataDir, userId, embedding, dynamics: options.memoryDynamics, now: options.memoryNow, recall: options.memoryRecall, mode: options.memoryMode }) : undefined;
      const sources: ToolSource[] = [{ source: "local", tools: [createLsToolDefinition(options.dataDir), createFindToolDefinition(options.dataDir), createGrepToolDefinition(options.dataDir), ...(options.executionTool ? [createBashToolDefinition(options.dataDir)] : [])] },
        ...(memory && request ? [{ source: "memory", tools: memoryTools(memory, request.id) }] : []),
        ...(tinyfish ? [{ source: "tinyfish", tools: tinyfish.tools.filter((tool) => tool.name !== "web_search") }] : []), ...connections.map((item) => item.source)];
      const catalog = createToolCatalog([skillRead(createBoundedRead(options.dataDir, request?.log ?? createRuntimeLog(options.dataDir)), skills, request),
        // write/edit retain the SDK's ordinary definitions and execution policy.
      ], sources, request);
      const webSearch = tinyfish?.tools.find((tool) => tool.name === "web_search") ?? unavailableWebSearch();
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
      if (native && model.api === "openai-responses") session.agent.streamFn = (selected, context, streamOptions) => streamNativeResponses(selected, context, streamOptions ?? {}, apiKey(request), catalog.searchCalls);
      if (native && model.api === "anthropic-messages") {
        const ordinaryStream = session.agent.streamFn;
        session.agent.streamFn = (selected, context, streamOptions) => ordinaryStream(selected, context, { ...streamOptions,
          onPayload: async (payload, selected) => {
            const customized = await streamOptions?.onPayload?.(payload, selected);
            return context.tools?.some((tool) => tool.name === "tool_search") ? anthropicSearchPayload(customized ?? payload, catalog, catalog.searchCalls) : customized ?? payload;
          } });
      }
      const visibleTools = session.agent.state.tools.filter((tool) => ["tool_search", "read", "write", "edit", "web_search", ...(!native ? ["tool_call"] : [])].includes(tool.name));
      await request?.log.append({ type: "capability_snapshot", requestId: request.id, catalogDigest: catalog.digest, skillsDigest: skills.digest, mode: native ? "native" : "compat", unavailableSources: failures, tools: catalog.snapshot });
      const execution = await attachExecution(session, model, { ...options, visibleTools, toolCatalogDigest: catalog.digest }, botPrompt, systemPrompt, request, memory);
      if (request && typeof userId === "number" && options.memoryBootstrap !== false && options.memoryMode !== "dense")
        void bootstrap.start(request.log, userId, request.id, { systemPrompt: session.agent.state.systemPrompt, messages: [], tools: session.agent.state.tools });
      session.agent.toolExecution = "sequential";
      const toolFailure = request ? attachToolRecording(session.agent, request) : () => undefined;
      session.agent.steeringMode = "all";
      const pendingSteers = new Map<UserMessage, SteeringInput>();
      const appliedSteers: SteeringInput[] = [];
      const closeSteering = request?.bindSteering?.((steer) => {
        const text = steer.input.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "请分析这张图片。";
        const images = steer.input.parts.flatMap((part) => part.type === "image" && part.data ? [{ type: "image" as const, mimeType: part.mimeType, data: part.data }] : []);
        const message: UserMessage = { role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() };
        pendingSteers.set(message, steer); session.agent.steer(message);
      });
      session.agent.subscribe(async (event) => {
        if (event.type === "message_end" && event.message.role === "user") {
          const steer = pendingSteers.get(event.message);
          if (!steer) return;
          pendingSteers.delete(event.message);
          if (!await steer.consume()) return;
          execution.invalidateFinal();
          session.agent.clearFollowUpQueue();
          await request?.log.append({ type: "protocol_feedback_superseded", requestId: request.id, reason: "user_steer", contextPolicy: "exclude" });
          const text = steer.input.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "请分析这张图片。";
          const images = steer.input.parts.flatMap((part) => part.type === "image" && part.data ? [{ type: "image" as const, mimeType: part.mimeType, data: part.data }] : []);
          await request?.log.append({ type: "message", role: "user", text, originalText: text, requestId: request.id, inputId: steer.id,
            chatId: userId, messageId: steer.input.metadata?.messageId, inputKind: "steer", ...(images.length ? { images } : {}) });
          if (request) await explicitSkills(steer.input.metadata?.skillSnapshot as SkillSnapshot ?? skills, text, { ...request, inputId: steer.id });
          appliedSteers.push(steer);
        }
      });
      if (request) request.onModelInput = async () => {
        request.signal?.throwIfAborted();
        for (const steer of appliedSteers.splice(0)) await steer.applied();
        request.signal?.throwIfAborted();
      };
      try {
        try {
          await session.prompt(current.text, { images: current.images });
          while (pendingSteers.size && !request?.signal?.aborted && !execution.failure()) await session.agent.continue();
          closeSteering?.();
        }
        catch (error) { throw toolFailure() ?? execution.failure() ?? error; }
        if (toolFailure()) throw toolFailure();
        if (execution.failure()) throw execution.failure();
        const last = session.messages.at(-1);
        if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
          throw new Error("模型调用失败");
        }
        if (execution.finalText() === undefined) throw new Error("模型未提交最终答复，本轮未完成");
        return execution.finalText()!;
      } finally {
        closeSteering?.();
        for (const steer of appliedSteers) await request?.log.append({ type: "steer_unapplied", inputId: steer.id, requestId: request.id, contextPolicy: "exclude" });
        request?.signal?.removeEventListener("abort", abort); session.dispose();
      }
    },
    async close(): Promise<void> { await bootstrap.close(); await embedding?.close(); await tinyfish?.close(); for (const connection of connections) await connection.close(); },
  };
}
