import { createHash } from "node:crypto";
import { getModel, type Api, type Model } from "@mariozechner/pi-ai";

export type ModelConfig = { alias: string; api: "openai-completions" | "openai-responses" | "anthropic-messages"; baseUrl: string;
  toolSearch?: "auto" | "native" | "compat";
  model: string; apiKey: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; images?: boolean };
export type ModelConfiguration = { defaultModel: string; models: ModelConfig[] };
export const validModelAlias = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_]*$/.test(value);

export function modelEnvironment(env: NodeJS.ProcessEnv): ModelConfiguration {
  const aliases = (env.MODEL_NAMES ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (!aliases.length || aliases.some((name) => !validModelAlias(name)) || new Set(aliases).size !== aliases.length)
    throw new Error("MODEL_NAMES 必须为逗号分隔且不重复的小写模型别名");
  const models: ModelConfig[] = [];
  for (const alias of aliases) {
    const prefix = `MODEL_${alias.toUpperCase()}_`;
    const key = env[`${prefix}API_KEY`]?.trim();
    if (!key) continue;
    const required = (field: string) => {
      const value = env[prefix + field]?.trim();
      if (!value) throw new Error(`缺少 ${prefix}${field}`);
      return value;
    };
    const api = required("API");
    if (api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages") throw new Error(`${prefix}API 只支持 openai-completions、openai-responses 或 anthropic-messages`);
    const toolSearch = env[`${prefix}TOOL_SEARCH`]?.trim() || "auto";
    if (!["auto", "native", "compat"].includes(toolSearch)) throw new Error(`${prefix}TOOL_SEARCH 必须为 auto、native 或 compat`);
    if (toolSearch === "native" && api === "openai-completions") throw new Error("Completions 不支持原生 Tool Search");
    const integer = (field: string) => {
      if (!env[prefix + field]?.trim()) return undefined;
      const value = Number(env[prefix + field]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${prefix}${field} 必须为正整数`);
      return value;
    };
    const boolean = (field: string) => {
      const value = env[prefix + field]?.trim();
      if (value === undefined || value === "") return undefined;
      if (value !== "true" && value !== "false") throw new Error(`${prefix}${field} 必须为 true 或 false`);
      return value === "true";
    };
    const baseUrl = required("BASE_URL");
    let url: URL; try { url = new URL(baseUrl); } catch { throw new Error(`${prefix}BASE_URL 无效`); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${prefix}BASE_URL 必须为不含凭据的 HTTP(S) 地址`);
    const config: ModelConfig = { alias, api, baseUrl, model: required("MODEL"), apiKey: key, toolSearch: toolSearch as ModelConfig["toolSearch"],
      contextWindow: integer("CONTEXT_WINDOW"), maxTokens: integer("MAX_OUTPUT_TOKENS"), reasoning: boolean("REASONING"), images: boolean("IMAGES") };
    configuredModel(config); models.push(config);
  }
  const defaultModel = env.MODEL_DEFAULT?.trim() || aliases[0]!;
  if (!models.some((item) => item.alias === defaultModel)) throw new Error("MODEL_DEFAULT 必须指向已配置 API Key 的模型别名");
  return { defaultModel, models };
}

export function configuredModel(config: ModelConfig): Model<Api> {
  const contextWindow = config.contextWindow ?? 128_000; const maxTokens = config.maxTokens ?? 16_384;
  if (!validModelAlias(config.alias) || !Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || contextWindow <= maxTokens)
    throw new Error("模型别名无效，或上下文窗口不大于最大输出 token");
  const identity = createHash("sha256").update(JSON.stringify([config.alias, config.api, config.baseUrl.replace(/\/$/, ""), config.model])).digest("hex").slice(0, 16);
  return { id: config.model, name: config.alias, api: config.api, provider: `endpoint-${identity}`, baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false, input: config.images === false ? ["text"] : ["text", "image"], contextWindow, maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: config.api === "anthropic-messages" ? undefined : config.api === "openai-responses" ? { supportsLongCacheRetention: false } :
      { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: config.reasoning ?? false, maxTokensField: "max_tokens" } };
}

export function nativeToolSearch(config?: ModelConfig): boolean {
  if (!config || config.toolSearch === "compat" || config.api === "openai-completions") return false;
  if (config.toolSearch === "native") return true; // Operator explicitly verified this model and endpoint.
  const url = new URL(config.baseUrl);
  if (config.api === "openai-responses") return url.origin === "https://api.openai.com" && /^gpt-(?:5\.[4-9]|[6-9])(?:[.-]|$)/.test(config.model);
  return url.origin === "https://api.anthropic.com" && /^claude-(?:opus|sonnet)-(?:4-[56]|[5-9])/.test(config.model);
}

/** Legacy application/test compatibility only; production entrypoints use modelEnvironment. */
export function deepseekModel(baseUrl?: string, contextWindow?: number): Model<Api> {
  const original = getModel("deepseek", "deepseek-v4-flash");
  if (!original) throw new Error("pi SDK 未提供 DeepSeek 模型");
  return { ...original, id: "deepseek-flash", name: "deepseek-flash", reasoning: false, input: ["text", "image"],
    ...(baseUrl ? { baseUrl } : {}), ...(contextWindow === undefined ? {} : { contextWindow }) };
}
