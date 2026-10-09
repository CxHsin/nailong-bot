import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Request } from "../application/app-types.js";
import { providerErrorCategory, safeProviderRequestId, transportCauses, type TransportCause } from "../runtime/transport-diagnostics.js";

type Observation = { causes: TransportCause[]; httpStatus: number | null; providerRequestId: string | null };
const active = new AsyncLocalStorage<Observation>();
const requests = new WeakMap<object, Observation>();
channel("undici:request:create").subscribe((event) => {
  const request = (event as { request?: object }).request;
  const observation = active.getStore();
  if (request && observation) requests.set(request, observation);
});
channel("undici:request:headers").subscribe((event) => {
  const { request, response } = event as { request?: object; response?: { statusCode?: number; headers?: Buffer[] } };
  const observation = request && requests.get(request);
  if (!observation || !response) return;
  observation.httpStatus = response.statusCode ?? null;
  const headers = response.headers ?? [];
  for (let index = 0; index < headers.length; index += 2) {
    if (["x-request-id", "request-id"].includes(headers[index]!.toString().toLowerCase()))
      observation.providerRequestId = safeProviderRequestId(headers[index + 1]?.toString());
  }
});
channel("undici:request:error").subscribe((event) => {
  const { request, error } = event as { request?: object; error?: unknown };
  const causes = request && requests.get(request)?.causes;
  if (causes && causes.length < 4) causes.push(...transportCauses(error).slice(0, 4 - causes.length));
});

/** Observe the selected provider without replacing fetch, changing retries or storing wire data. */
export async function startObservedProvider(streamFn: AgentSession["agent"]["streamFn"], model: Model<Api>, context: Context,
  options: SimpleStreamOptions, request: Request | undefined, callId: string, purpose: "execution" | "summary") {
  const started = performance.now();
  const observation: Observation = { causes: [], httpStatus: null, providerRequestId: null };
  const source = await active.run(observation, () => streamFn(model, context, { ...options,
    onResponse: async (response, selected) => {
      observation.httpStatus = response.status;
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
      observation.providerRequestId = safeProviderRequestId(headers["x-request-id"] ?? headers["request-id"]);
      await options.onResponse?.(response, selected);
    } }));
  return { source, record: async (message: AssistantMessage) => {
    await request?.log.append({ type: "model_transport", requestId: request.id, callId, purpose, provider: model.provider, model: model.id,
      ...observation, elapsedMs: Math.round(performance.now() - started), stopReason: message.stopReason,
      errorCategory: providerErrorCategory(message.stopReason, message.errorMessage, observation.causes), contextPolicy: "exclude" });
  } };
}
