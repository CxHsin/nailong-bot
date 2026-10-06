import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TestContext } from "node:test";

/** Capture callback failures for the test runner and always terminate the request. */
export function createTestServer(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, timeoutMs = 5000) {
  const failures: unknown[] = [];
  const server = createServer((req, res) => {
    const timer = setTimeout(() => fail(new Error("HTTP fixture response timed out")), timeoutMs);
    const fail = (error: unknown) => {
      failures.push(error);
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end("HTTP fixture failed");
    };
    res.once("close", () => clearTimeout(timer));
    Promise.resolve().then(() => handler(req, res)).catch(fail);
  });
  t.after(async () => {
    if (!failures.length) return;
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new AggregateError(failures, "HTTP fixture failed");
  });
  return server;
}
