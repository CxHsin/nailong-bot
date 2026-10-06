import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "typebox";

export function tinyfishResultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks.filter((item): item is { type: "text"; text: string } =>
    typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text).join("\n");
  return result.isError ? `查询失败：${text}` : text;
}

const endpoint = "https://agent.tinyfish.ai/mcp";

export async function connectTinyfish(apiKey: string, url = endpoint) {
  const client = new Client({ name: "personal-telegram-agent", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  await client.connect(transport);
  const available = (await client.listTools()).tools;
  const searchSchema = available.find((tool) => tool.name === "search")?.inputSchema;
  const fetchSchema = available.find((tool) => tool.name === "fetch_content")?.inputSchema;
  if (!searchSchema || !fetchSchema) {
    await client.close();
    throw new Error("TinyFish MCP 缺少 search 或 fetch_content 工具");
  }


  const search = defineTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the public web with TinyFish for current facts, sources and relevant URLs. Use when web grounding helps. Cite useful source URLs in your answer.",
    parameters: searchSchema as TSchema,
    execute: async (_id, params) => ({
      content: [{ type: "text" as const, text: tinyfishResultText(await client.callTool({ name: "search", arguments: params as Record<string, unknown> })) }],
      details: {},
    }),
  });

  const fetch = defineTool({
    name: "web_fetch",
    label: "Read Web Page",
    description: "Read public URLs with TinyFish to inspect page content. Defaults to ttl=0 to prefer a live fetch; set ttl explicitly to allow older cached content. Include the source URLs in your answer.",
    parameters: fetchSchema as TSchema,
    execute: async (_id, params) => ({
      content: [{ type: "text" as const, text: tinyfishResultText(await client.callTool({
        name: "fetch_content",
        // TinyFish accepts arbitrarily old cached pages when ttl is omitted.
        arguments: { ...params as Record<string, unknown>, ttl: (params as Record<string, unknown>).ttl ?? 0 },
      })) }],
      details: {},
    }),
  });

  return { tools: [search, fetch], close: () => client.close() };
}
