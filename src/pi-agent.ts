import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "./app.js";
import { connectTinyfish } from "./tinyfish.js";

export async function createPiAgent(options: {
  dataDir: string;
  promptFile: string;
  deepseekKey: string;
  tinyfishKey?: string;
}) {
  await mkdir(options.dataDir, { recursive: true });
  const systemPrompt = (await readFile(options.promptFile, "utf8")).trim();
  if (!systemPrompt) throw new Error("System prompt 文件为空");
  let tinyfish: Awaited<ReturnType<typeof connectTinyfish>> | undefined;
  if (options.tinyfishKey) {
    try { tinyfish = await connectTinyfish(options.tinyfishKey); }
    catch (error) { console.error("TinyFish 暂不可用，网页查询工具未启用：", (error as Error).message); }
  }
  const model = getModel("deepseek", "deepseek-v4-flash");
  if (!model) throw new Error("pi SDK 未提供 DeepSeek 模型");
  const authStorage = AuthStorage.create(join(options.dataDir, "auth.json"));
  authStorage.setRuntimeApiKey("deepseek", options.deepseekKey);
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } });
  const loader = new DefaultResourceLoader({
    cwd: options.dataDir,
    agentDir: options.dataDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    settingsManager,
  });
  await loader.reload();
  const sessionsDir = join(options.dataDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const pointerFile = join(options.dataDir, "current-session.json");
  const savedPath = await readFile(pointerFile, "utf8")
    .then((content) => (JSON.parse(content) as { path: string }).path)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  const canResume = savedPath ? await access(savedPath).then(() => true, () => false) : false;
  const initialManager = canResume && savedPath
    ? SessionManager.open(savedPath, sessionsDir, options.dataDir)
    : SessionManager.create(options.dataDir, sessionsDir);
  async function savePointer(manager: SessionManager): Promise<void> {
    await writeFile(pointerFile, JSON.stringify({ path: manager.getSessionFile() }), "utf8");
  }
  let session = (await createAgentSession({
    cwd: options.dataDir,
    agentDir: options.dataDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader: loader,
    model,
    thinkingLevel: "off",
    tools: tinyfish ? ["web_search", "web_fetch"] : [],
    customTools: tinyfish?.tools ?? [],
    sessionManager: initialManager,
  })).session;
  await savePointer(initialManager);

  return {
    async answer(messages: Message[]): Promise<string> {
      const current = messages.at(-1);
      if (!current || current.role !== "user") throw new Error("缺少用户消息");
      await session.prompt(current.text);
      return session.getLastAssistantText() ?? "";
    },
    async reset(): Promise<void> {
      session.dispose();
      const manager = SessionManager.create(options.dataDir, sessionsDir);
      session = (await createAgentSession({
        cwd: options.dataDir,
        agentDir: options.dataDir,
        authStorage,
        modelRegistry,
        settingsManager,
        resourceLoader: loader,
        model,
        thinkingLevel: "off",
        tools: tinyfish ? ["web_search", "web_fetch"] : [],
        customTools: tinyfish?.tools ?? [],
        sessionManager: manager,
      })).session;
      await savePointer(manager);
    },
    async close(): Promise<void> {
      session.dispose();
      await tinyfish?.close();
    },
  };
}
