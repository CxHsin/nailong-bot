import { appendRuntimeFact } from "../runtime/facts.js";
import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { validateToolArguments } from "@mariozechner/pi-ai";
import type { Request } from "../application/app-types.js";

// SDK tool definitions carry heterogeneous schema and renderer types.
export type RuntimeTool = ToolDefinition<any, any>;
export type ToolSource = { source: string; tools: RuntimeTool[] };
export type CatalogEntry = { name: string; source: string; originalName: string; description: string; parameters: ToolDefinition["parameters"]; digest: string; tool: ToolDefinition };
const stableNames = ["tool_search", "read", "write", "edit", "web_search", "tool_call"];
const textResult = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A frozen catalog and discovery state belong to exactly one Run. */
export function createToolCatalog(stable: RuntimeTool[], sources: ToolSource[], request?: Request) {
  const candidates = sources.flatMap(({ source, tools }) => tools.map((tool) => ({ source, tool })));
  const entries: CatalogEntry[] = candidates.map(({ source, tool }) => {
    const conflict = stableNames.includes(tool.name) || candidates.filter((item) => item.tool.name === tool.name).length > 1;
    const qualified = conflict ? `${source}__${tool.name}` : tool.name;
    // Keep provider names bounded while the original MCP name remains in metadata.
    const name = /^[a-zA-Z0-9_-]{1,64}$/.test(qualified) ? qualified :
      `${qualified.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 51)}_${digest([source, tool.name]).slice(0, 12)}`;
    const metadata = { name, source, originalName: tool.name, description: tool.description, parameters: tool.parameters };
    return { ...metadata, digest: digest(metadata), tool: { ...tool, name } };
  }).sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new Error("工具来源限定名称冲突");
  const discovered = new Set<string>();
  const searchCalls = new Set<string>();
  const metadata = ({ tool: _tool, ...entry }: CatalogEntry) => entry;
  const search = defineTool({ name: "tool_search", label: "Find tools",
    description: "Discover tools by exact name or keywords in name, description and parameter descriptions. Empty results: revise your query. Results stay available for this Run.",
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
    async execute(id, args) {
      searchCalls.add(id);
      const query = args.query.trim().toLowerCase();
      const words = query.split(/\s+/).filter(Boolean);
      const ranked = entries.map((entry) => {
        const haystack = JSON.stringify(metadata(entry)).toLowerCase();
        const exact = entry.name.toLowerCase() === query || entry.originalName.toLowerCase() === query;
        return { entry, score: exact ? 10000 : words.reduce((score, word) => score + (entry.name.toLowerCase().includes(word) ? 20 : haystack.includes(word) ? 1 : 0), 0) };
      }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name, "en"));
      const found = ranked.slice(0, args.limit ?? 5).map(({ entry }) => metadata(entry));
      for (const entry of found) discovered.add(entry.name);
      if (request) await appendRuntimeFact(request.log, { type: "tool_discovered", requestId: request.id, query: args.query, tools: found });
      return textResult({ tools: found, ...(found.length ? {} : { hint: "没有匹配工具，请修改查询。" }) });
    } });
  const invoke = async (name: string, args: unknown, id: string, signal: Parameters<ToolDefinition["execute"]>[2], update: Parameters<ToolDefinition["execute"]>[3], context: Parameters<ToolDefinition["execute"]>[4]) => {
    const entry = entries.find((entry) => entry.name === name);
    if (!entry || !discovered.has(name)) throw new Error(`工具未发现：${name}；先调用 tool_search。`);
    if (!Value.Check(entry.parameters, args)) throw new Error(`工具参数不符合 schema：${name}`);
    const validated = validateToolArguments(entry.tool, { type: "toolCall", id, name, arguments: args as Record<string, unknown> });
    if (request) await appendRuntimeFact(request.log, { type: "capability_dispatched", requestId: request.id, toolCallId: id, toolName: name, source: entry.source, digest: entry.digest, args: validated });
    const result = await entry.tool.execute(id, validated, signal, update, context);
    if (request) await appendRuntimeFact(request.log, { type: "capability_executed", requestId: request.id, toolCallId: id, toolName: name, source: entry.source, digest: entry.digest, result });
    return { ...result, details: { sourceToolName: entry.originalName, source: entry.source, sourceDetails: result.details } };
  };
  const call = defineTool({ name: "tool_call", label: "Call discovered tool", description: "Execute a tool previously discovered by tool_search in this Run. Pass its exact returned name and arguments matching its schema.",
    parameters: Type.Object({ name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
    execute: (id, args, signal, update, context) => invoke(args.name, args.arguments, id, signal, update, context) });
  const nativeTools = entries.map((entry) => ({ ...entry.tool,
    execute: (id: string, args: unknown, signal: Parameters<ToolDefinition["execute"]>[2], update: Parameters<ToolDefinition["execute"]>[3], context: Parameters<ToolDefinition["execute"]>[4]) => invoke(entry.name, args, id, signal, update, context) }));
  return { entries, discovered, searchCalls, stable: [search, ...stable], call, nativeTools,
    snapshot: entries.map(metadata), digest: digest(entries.map(metadata)) };
}

export function unavailableWebSearch(): ToolDefinition {
  return defineTool({ name: "web_search", label: "Web Search unavailable", description: "Web search is unavailable: TinyFish is not configured or its service connection failed. Report this limitation; local tools remain usable.",
    parameters: Type.Object({ query: Type.String() }), execute: async () => textResult("网页查询不可用：请配置 TinyFish 或检查服务连接。") });
}
