import { appendRuntimeFact } from "../runtime/facts.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Request } from "../application/app-types.js";
import { providerErrorCategory, safeProviderRequestId, transportCauses, type TransportCause } from "../runtime/transport-diagnostics.js";

type Observation = { causes: TransportCause[]; httpStatus: number | null; providerRequestId: string | null; headersMs: number | null; started: number };
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

/** Observe the selected provider without replacing fetch, changing retries or storing wire data. */
export async function startObservedProvider(streamFn: AgentSession["agent"]["streamFn"], model: Model<Api>, context: Context,
  options: SimpleStreamOptions, request: Request | undefined, callId: string, purpose: "execution" | "summary") {
  const started = performance.now();
  const observation: Observation = { causes: [], httpStatus: null, providerRequestId: null, headersMs: null, started };
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
    const { started: _started, ...transport } = observation;
    recorded = Promise.resolve(request ? appendRuntimeFact(request.log, { type: "model_transport", requestId: request.id, callId, purpose, provider: model.provider, model: model.id,
      ...transport, elapsedMs: elapsed(), stopReason: message?.stopReason ?? "error",
      firstStreamEventMs, firstPublicTextMs, terminalEventMs, normalTerminal,
      abortSource, abortMs, runSignalAborted: request.signal?.aborted ?? false, providerSignalAborted: options.signal?.aborted ?? false,
      configuredTimeoutMs: typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : null,
      errorCategory: abortSource !== "none" ? "aborted" : providerErrorCategory(message?.stopReason ?? "error", message?.errorMessage, observation.causes), contextPolicy: "exclude" }) : undefined);
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
