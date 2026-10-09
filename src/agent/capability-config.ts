import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { McpConfig } from "./mcp-catalog.js";
import type { SkillSource } from "./skills.js";

export type CapabilityConfig = { mcpServers?: McpConfig[]; skillSources?: SkillSource[]; executionTool?: boolean };
const schema = Type.Object({
  mcpServers: Type.Optional(Type.Array(Type.Object({ name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,24}$" }), url: Type.Optional(Type.String()), headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    command: Type.Optional(Type.String()), args: Type.Optional(Type.Array(Type.String())), env: Type.Optional(Type.Record(Type.String(), Type.String())), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })) }, { additionalProperties: false }))),
  skillSources: Type.Optional(Type.Array(Type.Object({ name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,24}$" }), path: Type.String({ minLength: 1 }) }, { additionalProperties: false }))),
  executionTool: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

/** No discovery of Codex, Pi, or other agents' global configuration. */
export async function capabilityEnvironment(env: NodeJS.ProcessEnv): Promise<CapabilityConfig> {
  const file = env.AGENT_CAPABILITIES_FILE?.trim(); if (!file) return {};
  const path = resolve(file); const input: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Value.Check(schema, input)) throw new Error("AGENT_CAPABILITIES_FILE 配置无效");
  const config = input as CapabilityConfig;
  const names = (config.mcpServers ?? []).map((server) => server.name);
  if (new Set(names).size !== names.length || names.some((name) => ["local", "memory", "tinyfish"].includes(name))) throw new Error("MCP 来源名重复或使用了内置来源名");
  for (const server of config.mcpServers ?? []) {
    if (!!server.url === !!server.command) throw new Error("MCP url/command 必须二选一");
    if (server.url) { const url = new URL(server.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("MCP URL 必须为无凭据的 HTTP(S) 地址"); }
  }
  return { ...config, skillSources: config.skillSources?.map((source) => ({ ...source, path: resolve(dirname(path), source.path) })) };
}
