export type TransportCause = { name?: string; code?: string };
const names = new Set(["Error", "TypeError", "SocketError", "ConnectTimeoutError", "HeadersTimeoutError", "BodyTimeoutError", "AbortError", "RequestAbortedError"]);
const codes = new Set(["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_ABORTED", "UND_ERR_DESTROYED", "UND_ERR_CLOSED", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR"]);
export const errorCategories = new Set(["none", "stream_terminated", "network", "aborted", "context_overflow", "provider_error", "unknown"]);
const providerCodes = new Set(["server_error", "rate_limit_exceeded", "context_length_exceeded", "invalid_request_error", "insufficient_quota", "overloaded_error", "authentication_error", "permission_denied", "model_not_found", "invalid_api_key", "request_timeout"]);
const eventTypes = new Set(["error", "response.failed"]);

export type ProviderError = { source: "sdk-message" | "exception" | "stream-event"; code: string | null; eventType: string | null };

/** SDKs may flatten the original event. Extract only a known code, never reconstruct an event type. */
export function providerFailure(message: unknown, error?: unknown): ProviderError | null {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; type?: unknown; error?: { code?: unknown } };
    const candidate = value.code ?? value.error?.code;
    const code = typeof candidate === "string" && providerCodes.has(candidate) ? candidate : null;
    const eventType = typeof value.type === "string" && eventTypes.has(value.type) ? value.type : null;
    if (code || eventType) return { source: "exception", code, eventType };
  }
  const candidate = typeof message === "string" ? /^(?:Error Code )?([a-z_]+):/.exec(message)?.[1] : undefined;
  return candidate && providerCodes.has(candidate) ? { source: "sdk-message", code: candidate, eventType: null } : null;
}

/** Revalidate persisted evidence before exposing it through the read-only CLI. */
export function safeProviderError(value: unknown): ProviderError | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ProviderError>;
  if (input.source !== "sdk-message" && input.source !== "exception" && input.source !== "stream-event") return null;
  const code = typeof input.code === "string" && providerCodes.has(input.code) ? input.code : null;
  const eventType = input.source !== "sdk-message" && typeof input.eventType === "string" && eventTypes.has(input.eventType) ? input.eventType : null;
  return code || eventType ? { source: input.source, code, eventType } : null;
}

/** Allow only diagnostic enums, never exception messages, URLs, sockets or headers. */
export function transportCauses(error: unknown): TransportCause[] {
  const result: TransportCause[] = [];
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error) && result.length < 4) {
    seen.add(error);
    const value = error as { name?: unknown; code?: unknown; cause?: unknown };
    const name = typeof value.name === "string" && names.has(value.name) ? value.name : undefined;
    const code = typeof value.code === "string" && codes.has(value.code) ? value.code : undefined;
    if (name || code) result.push({ ...(name ? { name } : {}), ...(code ? { code } : {}) });
    error = value.cause;
  }
  return result;
}

export function providerErrorCategory(stopReason: unknown, message: unknown, causes: TransportCause[] = [], failure = providerFailure(message)) {
  if (stopReason === "aborted") return "aborted";
  if (stopReason !== "error") return "none";
  if (message === "terminated") return "stream_terminated";
  if (failure?.code === "context_length_exceeded") return "context_overflow";
  if (failure) return "provider_error";
  if (causes.some((cause) => cause.code) || message === "fetch failed") return "network";
  if (typeof message === "string" && /context[_ ](?:length|window)|maximum context|上下文.*溢出/i.test(message)) return "context_overflow";
  return "unknown";
}

export function safeProviderRequestId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

/** Old or malformed records retain missing evidence instead of inventing a stage. */
export function streamEvidence(value?: Record<string, unknown>) {
  const time = (key: string) => typeof value?.[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0 ? value[key] as number : null;
  const flag = (key: string) => typeof value?.[key] === "boolean" ? value[key] as boolean : null;
  return {
    headersMs: time("headersMs"), firstStreamEventMs: time("firstStreamEventMs"), firstPublicTextMs: time("firstPublicTextMs"),
    terminalEventMs: time("terminalEventMs"), normalTerminal: flag("normalTerminal"), abortMs: time("abortMs"),
    abortSource: typeof value?.abortSource === "string" && ["none", "run-signal", "provider-signal", "timeout-signal"].includes(value.abortSource) ? value.abortSource : null,
    runSignalAborted: flag("runSignalAborted"), providerSignalAborted: flag("providerSignalAborted"), configuredTimeoutMs: time("configuredTimeoutMs"),
  };
}
