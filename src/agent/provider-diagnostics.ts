import { appendRuntimeFact } from "../runtime/facts.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Request } from "../application/app-types.js";
import { observeProviderResponse } from "./provider-stream-evidence.js";
import { providerErrorCategory, providerFailure, safeProviderError, safeProviderRequestId, transportCauses, type TransportCause, type ProviderError } from "../runtime/transport-diagnostics.js";

type Observation = { causes: TransportCause[]; httpStatus: number | null; providerRequestId: string | null; headersMs: number | null; started: number; responsesUrl: string | null; streamError: ProviderError | null };
const active = new AsyncLocalStorage<Observation>();
const originalFetch = globalThis.fetch;
// One delegating hook, never a per-request swap. ALS isolates concurrent calls and unrelated fetches.
globalThis.fetch = async (...args) => {
  const observation = active.getStore();
  const response = await originalFetch(...args);
  const input = args[0];
  const url = input instanceof globalThis.Request ? input.url : String(input);
  const method = args[1]?.method ?? (input instanceof globalThis.Request ? input.method : "GET");
  return observation?.responsesUrl === url && method.toUpperCase() === "POST" ?
    observeProviderResponse(response, (error) => { observation.streamError ??= error; }) : response;
};
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
  observation.headersMs ??= Math.round(performance.now() - observation.started);
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

/** Observe the selected provider without changing retries or persisting wire data. */
export async function startObservedProvider(streamFn: AgentSession["agent"]["streamFn"], model: Model<Api>, context: Context,
  options: SimpleStreamOptions, request: Request | undefined, callId: string, purpose: "execution" | "summary") {
  const started = performance.now();
  const observation: Observation = { causes: [], httpStatus: null, providerRequestId: null, headersMs: null, started,
    responsesUrl: model.api === "openai-responses" ? `${model.baseUrl.replace(/\/$/, "")}/responses` : null, streamError: null };
  let firstStreamEventMs: number | null = null; let firstPublicTextMs: number | null = null;
  let terminalEventMs: number | null = null; let normalTerminal = false;
  let abortSource: "none" | "run-signal" | "provider-signal" | "timeout-signal" = "none";
  let abortMs: number | null = null;
  const elapsed = () => Math.round(performance.now() - started);
  const removers: Array<() => void> = [];
  for (const [signal, source] of [[request?.signal, "run-signal"], [options.signal, "provider-signal"]] as const) {
    if (!signal) continue;
    const aborted = () => {
      if (abortSource !== "none") return;
      const trigger = request?.signal?.aborted ? request.signal : signal;
      abortSource = trigger.reason instanceof DOMException && trigger.reason.name === "TimeoutError" ? "timeout-signal" :
        request?.signal?.aborted ? "run-signal" : source;
      abortMs = elapsed();
    };
    if (signal.aborted) aborted();
    else { signal.addEventListener("abort", aborted, { once: true }); removers.push(() => signal.removeEventListener("abort", aborted)); }
  }
  let recorded: Promise<unknown> | undefined;
  const record = (message?: AssistantMessage, error?: unknown) => {
    if (recorded) return recorded;
    for (const remove of removers) remove();
    if (error) observation.causes.push(...transportCauses(error).slice(0, 4 - observation.causes.length));
    const { started: _started, responsesUrl: _responsesUrl, streamError, ...transport } = observation;
    const providerError = streamError ?? safeProviderError((message as (AssistantMessage & { providerError?: ProviderError }) | undefined)?.providerError) ??
      providerFailure(message?.errorMessage, error);
    recorded = Promise.resolve(request ? appendRuntimeFact(request.log, { type: "model_transport", requestId: request.id, callId, purpose, provider: model.provider, model: model.id,
      ...transport, elapsedMs: elapsed(), stopReason: message?.stopReason ?? "error",
      firstStreamEventMs, firstPublicTextMs, terminalEventMs, normalTerminal,
      abortSource, abortMs, runSignalAborted: request.signal?.aborted ?? false, providerSignalAborted: options.signal?.aborted ?? false,
      configuredTimeoutMs: typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : null,
      providerError,
      errorCategory: abortSource !== "none" ? "aborted" : providerErrorCategory(message?.stopReason ?? "error", message?.errorMessage, observation.causes, providerError), contextPolicy: "exclude" }) : undefined);
    return recorded;
  };
  let raw;
  try { raw = await active.run(observation, () => streamFn(model, context, { ...options,
    onResponse: async (response, selected) => {
      observation.headersMs ??= elapsed();
      observation.httpStatus = response.status;
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
      observation.providerRequestId = safeProviderRequestId(headers["x-request-id"] ?? headers["request-id"]);
      await options.onResponse?.(response, selected);
    } })); }
  catch (error) { await record(undefined, error); throw error; }
  const source = {
    async *[Symbol.asyncIterator](): AsyncIterableIterator<AssistantMessageEvent> {
      try {
        for await (const event of raw) {
          firstStreamEventMs ??= elapsed();
          if (event.type === "text_delta" && event.delta.length) firstPublicTextMs ??= elapsed();
          if (event.type === "done" || event.type === "error") {
            terminalEventMs = elapsed(); normalTerminal = event.type === "done";
            await record(event.type === "done" ? event.message : event.error);
          }
          yield event;
        }
      } catch (error) { await record(undefined, error); throw error; }
      finally { for (const remove of removers) remove(); }
    },
    async result() {
      try { return await raw.result(); }
      catch (error) { await record(undefined, error); throw error; }
    },
  };
  return { source, record };
}
