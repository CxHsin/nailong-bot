import { createModels, createProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { configuredModel, type ModelConfiguration } from "../agent/model-config.js";

/** Preserve endpoint identities and compatibility flags while moving execution to Durable's pi-ai. */
export function durableModels(configuration: ModelConfiguration) {
  const models = createModels();
  const available = configuration.models.map((config) => {
    const model = configuredModel(config) as unknown as Model<Api>;
    const api = config.api === "anthropic-messages" ? anthropicMessagesApi() :
      config.api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
    models.setProvider(createProvider({ id: model.provider, name: config.alias,
      baseUrl: model.baseUrl, models: [model], api,
      auth: { apiKey: { name: config.alias, resolve: async () => ({ auth: { apiKey: config.apiKey } }) } },
    }));
    return { alias: config.alias, model, ref: { provider: model.provider, modelId: model.id } };
  });
  function select(alias = configuration.defaultModel) {
    const selected = available.find((entry) => entry.alias === alias);
    if (!selected) throw new Error(`未配置模型：${alias}`);
    return selected;
  }
  select();
  return { models, available, select };
}
