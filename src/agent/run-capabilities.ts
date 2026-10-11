import { createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition, createBashToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Request } from "../application/app-types.js";
import { agentCommand } from "../application/commands.js";
import type { createMemoryProjection } from "../memory/projection.js";
import { memoryTools } from "../memory/tools.js";
import { appendRuntimeFact } from "../runtime/facts.js";
import { createRuntimeLog } from "../runtime/runtime-log.js";
import { createBoundedRead } from "./archive-read.js";
import { connectMcp, type McpConfig } from "./mcp-catalog.js";
import { createSkillStore } from "./skill-store.js";
import { scanSkills, explicitSkills, resolveExplicitSkills, skillRead, type SkillSource, type SkillSnapshot } from "./skills.js";
import { connectTinyfish } from "./tinyfish.js";
import { createToolCatalog, unavailableWebSearch, type ToolSource } from "./tool-catalog.js";

export type CapabilityOptions = {
  dataDir: string;
  tinyfishKey?: string;
  tinyfishUrl?: string;
  mcpServers?: McpConfig[];
  executionTool?: boolean;
  skillSources?: SkillSource[];
  skillFetch?: typeof fetch;
};

/** Connected sources live with the Agent; discovery and frozen Skill content live with each Run. */
export async function connectCapabilities(options: CapabilityOptions) {
  const skillStore = createSkillStore(options.dataDir, options.skillFetch);
  let tinyfish: Awaited<ReturnType<typeof connectTinyfish>> | undefined;
  if (options.tinyfishKey) {
    try { tinyfish = await connectTinyfish(options.tinyfishKey, options.tinyfishUrl); }
    catch { console.error("TinyFish 暂不可用，网页查询工具未启用。"); }
  }
  const connections: Awaited<ReturnType<typeof connectMcp>>[] = [];
  const failures: string[] = [];
  for (const config of options.mcpServers ?? []) {
    try { connections.push(await connectMcp(config)); }
    catch { failures.push(config.name); console.error(`MCP ${config.name} 暂不可用，本地工具仍可使用。`); }
  }
  // Installed sources are read anew at acceptance, while an accepted snapshot remains frozen.
  const readSnapshot = async () => scanSkills([...(options.skillSources ?? []), ...await skillStore.sources()]);
  return {
    failures,
    async validateInput(text: string, channel?: string) {
      const skills = await readSnapshot();
      if (!agentCommand(text)) resolveExplicitSkills(skills, text, channel);
      return skills;
    },
    async prepareCapabilities(text: string, request: Request) {
      request.skillSnapshot ??= await readSnapshot();
      if (!agentCommand(text)) request.loadedSkillPaths = (await explicitSkills(request.skillSnapshot, text, request)).map((skill) => skill.path);
    },
    installSkill: (text: string, request: Request) => skillStore.handle(text, request),
    snapshot: async (request?: Request) => request?.skillSnapshot ?? await readSnapshot(),
    freeze(skills: SkillSnapshot, native: boolean, request?: Request, memory?: ReturnType<typeof createMemoryProjection>) {
      const sources: ToolSource[] = [{ source: "local", tools: [createLsToolDefinition(options.dataDir), createFindToolDefinition(options.dataDir), createGrepToolDefinition(options.dataDir), ...(options.executionTool ? [createBashToolDefinition(options.dataDir)] : [])] },
        ...(memory && request ? [{ source: "memory", tools: memoryTools(memory, request.id) }] : []),
        ...(tinyfish ? [{ source: "tinyfish", tools: tinyfish.tools.filter((tool) => tool.name !== "web_search") }] : []), ...connections.map((item) => item.source)];
      const reader = skillRead(createBoundedRead(options.dataDir, request?.log ?? createRuntimeLog(options.dataDir)), skills, request);
      // write/edit retain the SDK's ordinary definitions and execution policy.
      const catalog = createToolCatalog([reader], sources, request);
      const webSearch = tinyfish?.tools.find((tool) => tool.name === "web_search") ?? unavailableWebSearch();
      return { reader, catalog, webSearch,
        async recordSnapshot() {
          if (request) await appendRuntimeFact(request.log, { type: "capability_snapshot", requestId: request.id, catalogDigest: catalog.digest,
            skillsDigest: skills.digest, mode: native ? "native" : "compat", unavailableSources: failures, tools: catalog.snapshot });
        },
      };
    },
    async close() { await tinyfish?.close(); for (const connection of connections) await connection.close(); },
  };
}
