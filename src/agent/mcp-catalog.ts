import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "typebox";
import type { ToolSource } from "./tool-catalog.js";

export type McpConfig = { name: string; url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string>; timeoutMs?: number };
export async function connectMcp(config: McpConfig) {
  if (!/^[a-z][a-z0-9_-]{0,24}$/.test(config.name) || (!!config.url === !!config.command)) throw new Error("MCP 需要有效来源名，以及 url 或 command 二选一");
  const client = new Client({ name: "nailong-bot", version: "0.1.0" });
  const transport = config.url ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }) :
    new StdioClientTransport({ command: config.command!, args: config.args, env: config.env });
  const timeout = config.timeoutMs ?? 10000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([client.connect(transport), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP 连接超时")), timeout); })]);
    const available = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
      available.push(...page.tools); cursor = page.nextCursor;
    } while (cursor);
    const source: ToolSource = { source: config.name, tools: available.map((tool) => defineTool({ name: tool.name, label: tool.name,
      description: tool.description ?? `MCP ${config.name}: ${tool.name}`, parameters: tool.inputSchema as TSchema,
      async execute(_id, args, signal) {
        const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, { timeout, signal });
        if (result.isError) throw new Error(JSON.stringify(result.content));
        const content = (Array.isArray(result.content) ? result.content : []).flatMap((part) => {
          if (part.type === "text" && typeof part.text === "string") return [{ type: "text" as const, text: part.text }];
          return [{ type: "text" as const, text: JSON.stringify(part) }];
        });
        return { content, details: { structuredContent: result.structuredContent } };
      } })) };
    return { source, close: () => client.close() };
  } catch (error) { await client.close().catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
}
