import type { RuntimeLog } from "../runtime/runtime-types.js";
import type { HostInput, RunResult } from "../host/host.js";
import type { AgentExecution } from "./agent-contract.js";
import { AGENT_COMMANDS, agentCommand, handlePromptCommand } from "./commands.js";
import { handleMemoryCommand } from "./memory-commands.js";
import { commandInput } from "./command-input.js";
import { cacheStatistics, cacheReportText } from "../runtime/cache-statistics.js";
import { validModelAlias } from "../agent/model-config.js";
import { appendRuntimeFact } from "../runtime/facts.js";

export async function control(options: { log: RuntimeLog; dataDir: string; promptFile: string; agent: AgentExecution }, input: HostInput, log: RuntimeLog): Promise<RunResult | undefined> {
  if (input.parts.some((part) => part.type !== "text")) return undefined;
  const text = input.parts.map((part) => part.type === "text" ? part.text : "").join("\n").trim();
  if (!text.startsWith("/")) return undefined;
  const match = /^\/([a-zA-Z0-9_]+)(?:\s|$)/.exec(text);
  const name = match?.[1] ?? text.slice(1).split(/\s/, 1)[0]!;
  const definition = agentCommand(text);
  if (!definition && input.metadata?.channel === "telegram") return undefined;
  await appendRuntimeFact(log, { type: "command_received", command: name, messageId: input.metadata?.messageId, contextPolicy: "exclude" });
  if (!definition) return { text: "未知命令，请发送 /help 查看帮助。", kind: "control" };
  if (name === "skill") return undefined;
  if (["help", "kvcache", "reset", "feed", "dance"].includes(name) && text !== `/${name}`)
    return { text: `用法：${definition.usage}`, kind: "control" };
  if (name === "help") return { text: AGENT_COMMANDS.map((item) => `${item.usage}\n${item.description}`).join("\n\n") + "\n\n技能调用：/skill-name [任务]；重名时用 /source:skill-name。首行可连续引用多个技能，也可不带参数。\nCLI：运行中 Ctrl+C 停止当前任务并保留会话；空闲时退出。", kind: "control" };
  if (name === "model") {
    const models = options.agent.models ?? [{ alias: "ds", name: "DeepSeek" }];
    const selected = (await log.read()).findLast((event) => event.type === "model_selected");
    const current = typeof selected?.modelAlias === "string" ? selected.modelAlias : options.agent.defaultModel ?? models[0]!.alias;
    if (text === "/model") return { text: `当前模型：${current}${models.some((item) => item.alias === current) ? "" : "（配置已移除）"}\n可选模型：\n${models.map((item) => `${item.alias}：${item.name}`).join("\n")}\n用法：/model 模型别名`, kind: "control" };
    const alias = /^\/model\s+(\S+)$/.exec(text)?.[1];
    if (!validModelAlias(alias)) return { text: `用法：${definition.usage}`, kind: "control" };
    if (!models.some((item) => item.alias === alias)) return { text: "该模型尚未配置或不存在，请用 /model 查看可选项。当前模型未改变。", kind: "control" };
    await appendRuntimeFact(log, { type: "model_selected", conversationId: input.conversationId, modelAlias: alias, contextPolicy: "exclude" });
    return { text: `已切换为 ${alias}，从下一轮生效。`, kind: "control" };
  }
  if (name === "kvcache") {
    const cache = cacheStatistics(await options.log.read(), input.conversationId);
    return { text: cacheReportText(cache), cache, kind: "control" };
  }
  if (name === "dance") return { text: "奶龙扭起来啦！", stickerCategory: "dance", kind: "control" };
  if (name === "feed") {
    await appendRuntimeFact(log, { type: "context_feed", contextPolicy: "exclude" });
    return { text: "你喂了奶龙一个奶香小面包，奶龙满足地拍了拍肚皮，现在的上下文精神头提升了 100%！", stickerCategory: "feed", stickerText: true, kind: "control" };
  }
  if (name === "reset") {
    await appendRuntimeFact(log, { type: "conversation_reset", conversationId: input.conversationId, source: "channel", contextPolicy: "exclude" });
    return { text: "已开始新上下文，旧记录和累计用量仍保留。", kind: "control" };
  }
  const identity = commandInput(input);
  const response = name === "prompt" ? await handlePromptCommand(log, { promptFile: options.promptFile }, identity, text) :
    await handleMemoryCommand(log, { dataDir: options.dataDir, purgeEmbeddingCache: options.agent.purgeEmbeddingCache }, identity, text);
  return { text: response ?? `用法：${definition.usage}`, kind: "control" };
}
