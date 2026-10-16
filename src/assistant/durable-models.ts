import { createModels, createProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { configuredModel, type ModelConfiguration } from "../agent/model-config.js";

/** Preserve endpoint identities and compatibility flags while moving execution to Durable's pi-ai. */
export type RequestMetric = { conversationId: string; model: string; provider: string; api: string;
  at: string; requestBytes: number; durationMs: number; input: number | null; output: number | null;
  cacheRead: number | null; cacheWrite: number | null; status: string };
export function durableModels(configuration: ModelConfiguration, observe?: { conversationId: string; record: (metric: RequestMetric) => void }) {
  const models = createModels();
  const available = configuration.models.map((config) => {
    const model = configuredModel(config) as unknown as Model<Api>;
    const api = config.api === "anthropic-messages" ? anthropicMessagesApi() :
      config.api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
    const provider = createProvider({ id: model.provider, name: config.alias,
      baseUrl: model.baseUrl, models: [model], api,
      auth: { apiKey: { name: config.alias, resolve: async () => ({ auth: { apiKey: config.apiKey } }) } },
    });
    if (observe) {
      const stream = provider.streamSimple.bind(provider);
      provider.streamSimple = (selected, transcript, options) => {
        const started = Date.now();
        let requestBytes = 0;
        let usageAvailable = false;
        let cacheReadAvailable = false;
        let cacheWriteAvailable = false;
        // Inspect the real provider encoding without replacing it or storing credentials/content.
        const events = stream(selected, transcript, { ...options,
          onPayload: async (payload, actual) => {
            requestBytes = Buffer.byteLength(JSON.stringify(payload));
            return options?.onPayload?.(payload, actual);
          },
          fetch: async (input, init) => {
            const response = await (options?.fetch ?? globalThis.fetch)(input, init);
            if (response.body) {
              const body = response.body;
              const reader = body.getReader();
              const decoder = new TextDecoder();
              let tail = "";
              const inspected = new ReadableStream<Uint8Array>({
                async pull(controller) {
                  const next = await reader.read();
                  if (next.done) { controller.close(); return; }
                  tail += decoder.decode(next.value, { stream: true });
                  for (const line of tail.split("\n").slice(0, -1)) {
                    if (line.startsWith("data: ")) {
                      try {
                        const data = JSON.parse(line.slice(6));
                        const usage = data.usage ?? data.message?.usage ?? data.response?.usage;
                        if (usage) {
                          usageAvailable = true;
                          cacheReadAvailable ||= usage.cache_read_input_tokens !== undefined || usage.prompt_cache_hit_tokens !== undefined ||
                            usage.prompt_tokens_details?.cached_tokens !== undefined || usage.input_tokens_details?.cached_tokens !== undefined;
                          cacheWriteAvailable ||= usage.cache_creation_input_tokens !== undefined || usage.prompt_cache_miss_tokens !== undefined;
                        }
                      } catch { /* SSE non-JSON terminator. */ }
                    }
                  }
                  tail = tail.slice(tail.lastIndexOf("\n") + 1);
                  controller.enqueue(next.value);
                },
                cancel(reason) { return reader.cancel(reason); },
              });
              return new Response(inspected, { status: response.status, statusText: response.statusText, headers: response.headers });
            }
            return response;
          },
        });
        void events.result().then((message) => observe.record({ conversationId: observe.conversationId,
          model: selected.id, provider: selected.provider, api: selected.api, at: new Date(started).toISOString(),
          requestBytes, durationMs: Date.now() - started, status: message.stopReason,
          input: usageAvailable ? message.usage.input : null, output: usageAvailable ? message.usage.output : null,
          cacheRead: cacheReadAvailable ? message.usage.cacheRead : null, cacheWrite: cacheWriteAvailable ? message.usage.cacheWrite : null,
        }));
        return events;
      };
    }
    models.setProvider(provider);
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
