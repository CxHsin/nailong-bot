import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const endpoint = "https://agent.tinyfish.ai/mcp";

export async function connectTinyfish(apiKey: string) {
  const client = new Client({ name: "personal-telegram-agent", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  await client.connect(transport);
  const available = new Set((await client.listTools()).tools.map((tool) => tool.name));
  if (!available.has("search") || !available.has("fetch_content")) {
    await client.close();
    throw new Error("TinyFish MCP 缺少 search 或 fetch_content 工具");
  }

  const resultText = (result: Awaited<ReturnType<typeof client.callTool>>): string => {
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks.filter((item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string")
      .map((item) => item.text).join("\n");
    return (result.isError ? `查询失败：${text}` : text).slice(0, 30_000);
  };

  const search = defineTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the public web with TinyFish for current facts, sources and relevant URLs. Use when web grounding helps. Cite useful source URLs in your answer.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      purpose: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => ({
      content: [{ type: "text" as const, text: resultText(await client.callTool({ name: "search", arguments: params })) }],
      details: {},
    }),
  });

  const fetch = defineTool({
    name: "web_fetch",
    label: "Read Web Page",
    description: "Read public URLs with TinyFish to inspect page content. Include the source URLs in your answer.",
    parameters: Type.Object({ urls: Type.Array(Type.String({ format: "uri" }), { minItems: 1, maxItems: 10 }) }),
    execute: async (_id, params) => ({
      content: [{ type: "text" as const, text: resultText(await client.callTool({
        name: "fetch_content",
        arguments: { urls: params.urls, format: "markdown", links: false, image_links: false, page_metadata: false },
      })) }],
      details: {},
    }),
  });

  return { tools: [search, fetch], close: () => client.close() };
}
