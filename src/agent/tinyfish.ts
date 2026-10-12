import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "typebox";
import type { RetrievalAdapter } from '../personal/research-receipts.js';
import { sourceUrl } from '../personal/research-receipts.js';

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
      content: [{ type: "text" as const, text: await successfulText({ name: "search", arguments: params as Record<string, unknown> }) }],
      details: {},
    }),
  });

  const fetch = defineTool({
    name: "web_fetch",
    label: "Read Web Page",
    description: "Read public URLs with TinyFish to inspect page content. Defaults to ttl=0 to prefer a live fetch; set ttl explicitly to allow older cached content. Include the source URLs in your answer.",
    parameters: fetchSchema as TSchema,
    execute: async (_id, params) => ({
      content: [{ type: "text" as const, text: await successfulText({
        name: "fetch_content",
        // TinyFish accepts arbitrarily old cached pages when ttl is omitted.
        arguments: { ...params as Record<string, unknown>, ttl: (params as Record<string, unknown>).ttl ?? 0 },
      }) }],
      details: {},
    }),
  });

  async function successfulText(args: Parameters<Client['callTool']>[0]) { const result = await client.callTool(args); if (result.isError) throw new Error(tinyfishResultText(result)); const text = tinyfishResultText(result); if (!text.trim()) throw new Error('Tinyfish 没有返回实际内容'); return text; }
  const retrieval: RetrievalAdapter = { provider: 'tinyfish', version: 'single-url-provider-content-v1', validateArgs(args) {
    if (!Array.isArray(args.urls) || args.urls.length !== 1 || typeof args.urls[0] !== 'string') throw new Error('来源回执要求单个 URL；组合响应不能归因于每个页面');
    sourceUrl(args.urls[0]);
  }, extract(args, result) {
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    return [{ url: (args.urls as string[])[0]!, payload: content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n') }];
  } };
  return { tools: [search, fetch], retrieval, close: () => client.close() };
}
