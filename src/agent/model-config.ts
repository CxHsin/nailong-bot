import { getModel, type Api, type Model } from "@mariozechner/pi-ai";

export type ModelAlias = "ds" | "gpt";
export type GptConfig = { apiKey: string; baseUrl?: string; model?: string; contextWindow?: number; maxTokens?: number };

export function gptEnvironment(env: NodeJS.ProcessEnv): GptConfig | undefined {
  if (!env.XH_API_KEY?.trim()) return undefined;
  const integer = (name: string) => {
    if (!env[name]?.trim()) return undefined;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
    return value;
  };
  return { apiKey: env.XH_API_KEY.trim(), baseUrl: env.XH_BASE_URL?.trim(), model: env.XH_MODEL?.trim(),
    contextWindow: integer("XH_CONTEXT_WINDOW"), maxTokens: integer("XH_MAX_OUTPUT_TOKENS") };
}

export function gptModel(config: GptConfig): Model<Api> {
  const contextWindow = config.contextWindow ?? 128_000;
  const maxTokens = config.maxTokens ?? 16_384;
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || contextWindow <= maxTokens)
    throw new Error("GPT 上下文窗口必须大于最大输出 token，且两者为正整数");
  return { id: config.model ?? "gpt-6.1-sol", name: "XH GPT", api: "openai-responses", provider: "xh",
    baseUrl: config.baseUrl ?? "https://newapi.xinghengcode.shop/v1", reasoning: true, input: ["text", "image"],
    contextWindow, maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsLongCacheRetention: false } };
}

export function deepseekModel(baseUrl?: string, contextWindow?: number): Model<Api> {
  const original = getModel("deepseek", "deepseek-v4-flash");
  if (!original) throw new Error("pi SDK 未提供 DeepSeek 模型");
  return { ...original, id: "deepseek-flash", name: "deepseek-flash", input: ["text", "image"],
    ...(baseUrl ? { baseUrl } : {}), ...(contextWindow === undefined ? {} : { contextWindow }) };
}
