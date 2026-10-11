import { streamProviderFailure, type ProviderError } from "../runtime/transport-diagnostics.js";

const maxFrameBytes = 64 * 1024;

/** Inspect consumed SSE bytes only. Oversized frames are skipped; bytes pass through unchanged. */
export function observeProviderResponse(response: Response, record: (error: ProviderError) => void): Response {
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return response;
  const reader = response.body.getReader();
  let frame: number[] = []; let oversized = false; let lineLength = 0; let previousCR = false;
  const finish = () => {
    if (!oversized) {
      const text = new TextDecoder().decode(new Uint8Array(frame));
      const data = text.split(/\r\n|\r|\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      try { const failure = streamProviderFailure(JSON.parse(data)); if (failure) record(failure); } catch { /* Not a JSON error event. */ }
    }
    frame = []; oversized = false;
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { frame = []; reader.releaseLock(); controller.close(); return; }
        for (const byte of value) {
          if (!oversized) {
            if (frame.length < maxFrameBytes) frame.push(byte);
            else { frame = []; oversized = true; }
          }
          if (byte === 10 && previousCR) { previousCR = false; continue; }
          previousCR = byte === 13;
          if (byte === 10 || byte === 13) { if (lineLength === 0) finish(); lineLength = 0; }
          else lineLength++;
        }
        controller.enqueue(value);
      } catch (error) { frame = []; reader.releaseLock(); controller.error(error); }
    },
    async cancel(reason) { frame = []; try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }, { highWaterMark: 0 });
  const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  // Preserve fetch metadata while all body consumption methods operate on the observed stream.
  for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(observed, key, { value: response[key] });
  return observed;
}
