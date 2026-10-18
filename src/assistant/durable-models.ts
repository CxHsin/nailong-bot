import { createModels, createProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { configuredModel, type ModelConfiguration, type ModelConfig } from "../agent/model-config.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Preserve endpoint identities and compatibility flags while moving execution to Durable's pi-ai. */
export type RequestMetric = { conversationId: string; model: string; provider: string; api: string;
  at: string; requestBytes: number; durationMs: number; input: number | null; output: number | null;
  cacheRead: number | null; cacheWrite: number | null; status: string;
  requestId?: string; batchId?: string; purpose?: "execution" | "auxiliary" };
export function durableModels(configuration: ModelConfiguration, observe?: {
  conversationId: string; batchId?: () => string | undefined; record: (metric: RequestMetric) => void;
  beforeRequest?: (model: ModelConfig) => void;
}) {
  const models = createModels();
  // Durable streams main generations; completeSimple is used for summaries and memory extraction.
  const purpose = new AsyncLocalStorage<"auxiliary">();
  const complete = models.completeSimple.bind(models);
  models.completeSimple = (...args) => purpose.run("auxiliary", () => complete(...args));
  function register(config: ModelConfig) {
    const model = configuredModel(config) as unknown as Model<Api>;
    if (config.alias === "magpie") model.headers = { "User-Agent": "Nailong/0.1" };
    const api = config.api === "anthropic-messages" ? anthropicMessagesApi() :
      config.api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
    const provider = createProvider({ id: model.provider, name: config.alias,
      baseUrl: model.baseUrl, models: [model], api,
      auth: { apiKey: { name: config.alias, resolve: async () => ({ auth: { apiKey: config.apiKey } }) } },
    });
    if (observe) {
      const stream = provider.streamSimple.bind(provider);
      provider.streamSimple = (selected, transcript, options) => {
        if (config.alias === "magpie") observe.beforeRequest?.(config);
        if (config.alias === "magpie" && !selected.input.includes("image") && transcript.messages.some(message =>
          Array.isArray(message.content) && message.content.some(part => part.type === "image")))
          throw new Error("已选模型明确不支持图片；上下文和图片已保留，请选择支持图片的模型后明确继续。");
        const started = Date.now();
        const identity = { requestId: randomUUID(), batchId: observe.batchId?.(),
          purpose: purpose.getStore() ?? "execution" as const };
        const pending: RequestMetric = { ...identity, conversationId: observe.conversationId,
          model: selected.id, provider: selected.provider, api: selected.api, at: new Date(started).toISOString(),
          requestBytes: 0, durationMs: 0, input: null, output: null, cacheRead: null, cacheWrite: null, status: "pending" };
        observe.record(pending);
        let requestBytes = 0;
        let usageAvailable = false;
        let inputAvailable = false;
        let cacheReadAvailable = false;
        let cacheWriteAvailable = false;
        // Inspect the real provider encoding without replacing it or storing credentials/content.
        const events = stream(selected, transcript, { ...options,
          onPayload: async (payload, actual) => {
            // Magpie's explicit catalog levels can exceed pi-ai's generic effort enum.
            // Preserve the native request checkpoint's selected value at this protocol boundary.
            if (config.alias === "magpie" && options?.reasoning)
              (payload as {reasoning_effort?:string}).reasoning_effort = options.reasoning;
            requestBytes = Buffer.byteLength(JSON.stringify(payload));
            return options?.onPayload?.(payload, actual);
          },
          fetch: async (input, init) => {
            if (config.alias === "magpie") observe.beforeRequest?.(config);
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
                          inputAvailable ||= usage.input_tokens != null || usage.prompt_tokens != null;
                          cacheReadAvailable ||= usage.cache_read_input_tokens != null || usage.prompt_cache_hit_tokens != null ||
                            usage.cached_tokens != null || usage.prompt_tokens_details?.cached_tokens != null || usage.input_tokens_details?.cached_tokens != null;
                          cacheWriteAvailable ||= usage.cache_creation_input_tokens != null || usage.prompt_cache_miss_tokens != null ||
                            usage.prompt_tokens_details?.cache_write_tokens != null;
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
        void events.result().then((message) => observe.record({ ...identity, conversationId: observe.conversationId,
          model: selected.id, provider: selected.provider, api: selected.api, at: new Date(started).toISOString(),
          requestBytes, durationMs: Date.now() - started, status: message.stopReason,
          input: inputAvailable ? message.usage.input : null, output: usageAvailable ? message.usage.output : null,
          cacheRead: cacheReadAvailable ? message.usage.cacheRead : null, cacheWrite: cacheWriteAvailable ? message.usage.cacheWrite : null,
        }));
        return events;
      };
    }
    models.setProvider(provider);
    return { alias: config.alias, model, ref: { provider: model.provider, modelId: model.id } };
  }
  const available = configuration.models.map(register);
  function select(alias = configuration.defaultModel) {
    const selected = available.find((entry) => entry.alias === alias);
    if (!selected) throw new Error(`未配置模型：${alias}`);
    return selected;
  }
  return { models, available, select, register };
}
