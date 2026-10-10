export type TransportCause = { name?: string; code?: string };
const names = new Set(["Error", "TypeError", "SocketError", "ConnectTimeoutError", "HeadersTimeoutError", "BodyTimeoutError", "AbortError", "RequestAbortedError"]);
const codes = new Set(["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_ABORTED", "UND_ERR_DESTROYED", "UND_ERR_CLOSED", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR"]);
export const errorCategories = new Set(["none", "stream_terminated", "network", "aborted", "context_overflow", "unknown"]);

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

export function providerErrorCategory(stopReason: unknown, message: unknown, causes: TransportCause[] = []) {
  if (stopReason === "aborted") return "aborted";
  if (stopReason !== "error") return "none";
  if (message === "terminated") return "stream_terminated";
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
