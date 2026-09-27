import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry,
  SessionManager, SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "./app.js";
import { connectTinyfish } from "./tinyfish.js";

export async function createPiAgent(options: {
  dataDir: string;
  promptFile: string;
  deepseekKey: string;
  tinyfishKey?: string;
  modelBaseUrl?: string;
  tinyfishUrl?: string;
}) {
  const systemPrompt = (await readFile(options.promptFile, "utf8")).trim();
  if (!systemPrompt) throw new Error("System prompt 文件为空");
  let tinyfish: Awaited<ReturnType<typeof connectTinyfish>> | undefined;
  if (options.tinyfishKey) {
    try { tinyfish = await connectTinyfish(options.tinyfishKey, options.tinyfishUrl); }
    catch { console.error("TinyFish 暂不可用，网页查询工具未启用。"); }
  }
  const defaultModel = getModel("deepseek", "deepseek-v4-flash");
  if (!defaultModel) throw new Error("pi SDK 未提供 DeepSeek 模型");
  const model = options.modelBaseUrl ? { ...defaultModel, baseUrl: options.modelBaseUrl } : defaultModel;
  const authStorage = AuthStorage.create(join(options.dataDir, "auth.json"));
  authStorage.setRuntimeApiKey("deepseek", options.deepseekKey);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: options.dataDir, agentDir: options.dataDir,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    settingsManager,
  });
  await loader.reload();

  return {
    async answer(messages: Message[]): Promise<string> {
      const current = messages.at(-1);
      if (!current || current.role !== "user") throw new Error("缺少用户消息");
      const manager = SessionManager.inMemory(options.dataDir);
      for (const message of messages.slice(0, -1)) {
        if (message.role === "user") {
          manager.appendMessage({ role: "user", content: message.text, timestamp: Date.now() });
        } else {
          manager.appendMessage({
            role: "assistant", content: [{ type: "text", text: message.text }],
            api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop", timestamp: Date.now(),
          });
        }
      }
      const { session } = await createAgentSession({
        cwd: options.dataDir, agentDir: options.dataDir,
        authStorage, modelRegistry: ModelRegistry.create(authStorage),
        settingsManager, resourceLoader: loader, model, thinkingLevel: "off",
        tools: tinyfish ? ["web_search", "web_fetch"] : [],
        customTools: tinyfish?.tools ?? [], sessionManager: manager,
      });
      try {
        await session.prompt(current.text);
        const last = session.messages.at(-1);
        if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
          throw new Error("模型调用失败");
        }
        return session.getLastAssistantText() ?? "";
      } finally { session.dispose(); }
    },
    async close(): Promise<void> { await tinyfish?.close(); },
  };
}
