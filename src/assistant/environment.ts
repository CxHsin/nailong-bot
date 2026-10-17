import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { capabilityEnvironment } from "../agent/capability-config.js";
import { modelEnvironment } from "../agent/model-config.js";
import { connectMcp } from "../agent/mcp-catalog.js";
import { connectTinyfish } from "../agent/tinyfish.js";
import { createAssistant } from "./runtime.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { IntentOptions } from "./intent.js";

export function intentEnvironment(env: NodeJS.ProcessEnv): IntentOptions {
  const intent: IntentOptions = {};
  const model = env.ASSISTANT_INTENT_MODEL?.trim();
  if (model) intent.model = model;
  const fields = { timeoutMs: "TIMEOUT_MS", inputTokens: "INPUT_TOKENS", outputTokens: "OUTPUT_TOKENS", recentTurns: "RECENT_TURNS" } as const;
  for (const [key, suffix] of Object.entries(fields)) {
    const name = `ASSISTANT_INTENT_${suffix}`;
    const raw = env[name]?.trim(); if (!raw) continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
    intent[key as keyof typeof fields] = value;
  }
  return intent;
}

const positive = () => Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 }));
const contextSchema = Type.Object({
  archive: Type.Optional(Type.Object(Object.fromEntries(["thresholdBytes", "previewBytes", "readBytes", "maxReadBytes", "readLines", "maxReadLines", "searchLimit", "maxSearchLimit", "searchBytes"].map((key) => [key, positive()])), { additionalProperties: false })),
  memory: Type.Optional(Type.Object(Object.fromEntries(["residentBytes", "topicBytes", "akashaBytes", "inputBytes", "searchResults", "readBytes"].map((key) => [key, positive()])), { additionalProperties: false })),
  media: Type.Optional(Type.Object({ batchImages: positive(), maxInlineBytes: positive() }, { additionalProperties: false })),
  compaction: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()), reserveTokens: positive(), keepRecentTokens: positive(),
    backgroundTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })) }, { additionalProperties: false })),
}, { additionalProperties: false });

/** Uses a fresh namespace; never runs legacy migrations or loads Akasha. */
export async function assistantEnvironment(
  env: NodeJS.ProcessEnv = process.env,
) {
  const prompt = env.AGENT_SYSTEM_PROMPT;
  if (!prompt?.trim()) throw new Error("AGENT_SYSTEM_PROMPT 必须提供非空基础指令（支持多行文本）");
  const dataDir = resolve(
    env.ASSISTANT_DATA_DIR?.trim() || "data/pi-durable-v1",
  );
  const cwd = resolve(env.ASSISTANT_WORK_DIR?.trim() || process.cwd());
  const contextFile = env.ASSISTANT_CONTEXT_CONFIG_FILE?.trim();
  const contextInput: unknown = contextFile ? JSON.parse(await readFile(resolve(contextFile), "utf8")) : {};
  if (!Value.Check(contextSchema, contextInput)) throw new Error("ASSISTANT_CONTEXT_CONFIG_FILE 配置无效");
  const contextConfig = contextInput as Pick<Parameters<typeof createAssistant>[0], "archive" | "memory" | "media" | "compaction">;
  const capabilities = await capabilityEnvironment(env);
  const connections: Awaited<ReturnType<typeof connectMcp>>[] = [];
  let web: Awaited<ReturnType<typeof connectTinyfish>> | undefined;
  try {
    for (const config of capabilities.mcpServers ?? [])
      connections.push(await connectMcp(config));
    if (env.TINYFISH_API_KEY?.trim())
      web = await connectTinyfish(env.TINYFISH_API_KEY.trim());
    const app = await createAssistant({
      ...contextConfig,
      dataDir,
      cwd,
      modelConfiguration: modelEnvironment(env),
      intent: intentEnvironment(env),
      prompt,
      skillPaths: [
        resolve(".agents/skills"),
        ...(capabilities.skillSources?.map((source) => source.path) ?? []),
      ],
      tools: [
        ...connections.flatMap((connection) => connection.source.tools),
        ...(web?.tools ?? []),
      ],
      shellPath: env.AGENT_SHELL_PATH?.trim(),
    });
    return {
      app,
      dataDir,
      async close() {
        try {
          await app.close();
        } finally {
          for (const connection of connections) await connection.close();
          await web?.close();
        }
      },
    };
  } catch (error) {
    for (const connection of connections) await connection.close();
    await web?.close();
    throw error;
  }
}
