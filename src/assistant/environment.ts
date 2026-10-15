import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { capabilityEnvironment } from "../agent/capability-config.js";
import { modelEnvironment } from "../agent/model-config.js";
import { connectMcp } from "../agent/mcp-catalog.js";
import { connectTinyfish } from "../agent/tinyfish.js";
import { createAssistant } from "./runtime.js";

/** Uses a fresh namespace; never runs legacy migrations or loads Akasha. */
export async function assistantEnvironment(
  env: NodeJS.ProcessEnv = process.env,
) {
  const dataDir = resolve(
    env.ASSISTANT_DATA_DIR?.trim() || "data/pi-durable-v1",
  );
  const cwd = resolve(env.ASSISTANT_WORK_DIR?.trim() || process.cwd());
  const capabilities = await capabilityEnvironment(env);
  const connections: Awaited<ReturnType<typeof connectMcp>>[] = [];
  let web: Awaited<ReturnType<typeof connectTinyfish>> | undefined;
  try {
    for (const config of capabilities.mcpServers ?? [])
      connections.push(await connectMcp(config));
    if (env.TINYFISH_API_KEY?.trim())
      web = await connectTinyfish(env.TINYFISH_API_KEY.trim());
    const app = await createAssistant({
      dataDir,
      legacyDataDir: resolve(env.ASSISTANT_LEGACY_DATA_DIR?.trim() || "data/pi-assistant-v1"),
      cwd,
      modelConfiguration: modelEnvironment(env),
      prompt: await readFile(
        resolve(env.AGENT_PROMPT_FILE?.trim() || "system-prompt.md"),
        "utf8",
      ),
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
