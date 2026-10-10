import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { configuredModel, deepseekModel, nativeToolSearch, type ModelConfiguration } from "./model-config.js";
import { memoryBudget, type MemoryBudget } from "../application/memory-context.js";
import { modelInputBudget } from "../context/input-budget.js";

export type ModelOptions = {
  modelConfiguration?: ModelConfiguration;
  /** Legacy application/test compatibility. Production uses modelConfiguration. */
  deepseekKey?: string;
  modelBaseUrl?: string;
  contextWindow?: number;
  contextBudgetRatio?: number;
  modelBudgetRatios?: Record<string, number>;
  memoryBudget?: MemoryBudget;
};

/** Model identity, credentials and tool-search policy are selected as one profile. */
export function createAgentModels(options: ModelOptions) {
  const profiles = options.modelConfiguration ? options.modelConfiguration.models.map((config) => ({ alias: config.alias, model: configuredModel(config), apiKey: config.apiKey })) :
    [{ alias: "ds", model: deepseekModel(options.modelBaseUrl, options.contextWindow), apiKey: options.deepseekKey ?? "" }];
  const defaultModel = options.modelConfiguration?.defaultModel ?? "ds";
  const defaultProfile = profiles.find((item) => item.alias === defaultModel);
  if (!defaultProfile?.apiKey) throw new Error("默认模型未配置密钥");
  const modelBudgetRatios = { ...options.modelBudgetRatios,
    ...Object.fromEntries(profiles.filter((profile) => options.modelBudgetRatios?.[profile.alias] !== undefined)
      .map((profile) => [`${profile.model.provider}/${profile.model.id}`, options.modelBudgetRatios![profile.alias]!])) };
  for (const profile of profiles) memoryBudget(modelInputBudget(profile.model, options.contextBudgetRatio, modelBudgetRatios).budget, options.memoryBudget);
  return {
    defaultModel, defaultProfile, modelBudgetRatios,
    models: profiles.map((profile) => ({ alias: profile.alias, name: profile.model.id })),
    select(requestedAlias?: string) {
      const alias = requestedAlias ?? defaultModel;
      const profile = profiles.find((item) => item.alias === alias);
      if (!profile) throw new Error("当前对话选择的模型已移除；请用 /model 选择已配置的模型。");
      const native = nativeToolSearch(options.modelConfiguration?.models.find((config) => config.alias === alias));
      return { ...profile, native };
    },
    registerRuntimeKeys(authStorage: AuthStorage) {
      for (const profile of profiles) authStorage.setRuntimeApiKey(profile.model.provider, profile.apiKey);
    },
  };
}
