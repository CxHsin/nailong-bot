import { createServer, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { telegramFixture } from "./telegram.js";
import { sendChatCompletion } from "./chat-completion.js";
import type { Wire } from "./assistant.js";

export type CatalogEntry = { id: string; display_name?: string; owned_by?: string; reasoning?: boolean; supported_reasoning_levels?: string[]; context_window?: number; max_output_tokens?: number; modalities?: string[] };
export async function controlPanelFixture(options: {
  models?: CatalogEntry[]; selected?: string; noSelection?: boolean;
  onApi?: (method: string, body: unknown) => void;
  provider?: (wire: Wire & { model: string; reasoning_effort?: string }, response: ServerResponse) => void | Promise<void>;
} = {}) {
  let models = options.models ?? [{ id: "provider/A", display_name: "Alpha", reasoning: true, supported_reasoning_levels: ["low", "medium", "high"] },
    { id: "provider/B", display_name: "Beta", reasoning: false }, { id: "route/team/C", display_name: "Gamma", reasoning: true, supported_reasoning_levels: ["low", "high"] }];
  let catalogFailure = false; let catalogReads = 0;
  const requests: Array<Wire & { model: string; reasoning_effort?: string }> = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      catalogReads++;
      response.writeHead(catalogFailure ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(catalogFailure ? { error: "catalog unavailable" } : { data: models })); return;
    }
    let data = ""; for await (const part of request) data += part;
    try {
      const wire = JSON.parse(data); requests.push(wire);
      if (options.provider) await options.provider(wire, response); else sendChatCompletion(response, "confirmed answer");
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  let configPath = "";
  const f = await telegramFixture((_wire, response) => { response.writeHead(500); response.end("unexpected legacy direct request"); }, undefined, undefined,
    async directory => {
      configPath = join(directory, "magpie.json");
      await writeFile(configPath, JSON.stringify({ baseUrl, apiKey: "fixture-secret", ...(options.noSelection ? {} : { model: `magpie/${options.selected ?? models[0]?.id}` }), unrelated: "keep" }));
      return { magpie: { configPath, primaryConversationId: "telegram:private:42", catalogTimeoutMs: 500 } };
    }, options.onApi);
  return { ...f, get app() { return f.app; }, get bot() { return f.bot; }, get channel() { return f.channel; }, requests, configPath,
    setModels(value: CatalogEntry[]) { models = value; }, setCatalogFailure(value: boolean) { catalogFailure = value; }, get catalogReads() { return catalogReads; },
    async close() { await f.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
