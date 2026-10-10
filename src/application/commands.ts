import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import type { Update } from "./app-types.js";

export const AGENT_COMMANDS = [
  { command: "help", description: "查看命令帮助", usage: "/help" },
  { command: "steer", description: "引导当前任务，工具批次完成后生效", usage: "/steer 内容" },
  { command: "stop", description: "停止当前任务并取消此前待处理输入", usage: "/stop" },
  { command: "kvcache", description: "查看最近五组运行的缓存详情", usage: "/kvcache" },
  { command: "model", description: "查看或切换当前对话模型", usage: "/model；/model 模型别名" },
  { command: "skill", description: "显式安装或更新技能", usage: "/skill install 链接；/skill update 链接" },
  { command: "dance", description: "看奶龙扭秧歌", usage: "/dance" },
  { command: "feed", description: "喂奶龙小面包，提升下一轮上下文预算", usage: "/feed" },
  { command: "reset", description: "开始新上下文，保留记录和累计统计", usage: "/reset" },
  { command: "prompt", description: "查看、设置或恢复 bot 提示词", usage: "/prompt；/prompt set 提示词；/prompt reset" },
  { command: "forget", description: "排除指定旧轮次的记忆和上下文", usage: "/forget 节点引用；回复目标消息发送 /forget" },
  { command: "memory", description: "诊断查阅原始轮次日志", usage: "/memory log 节点引用 [字符位置]" },
] as const;

export function agentCommand(text: string) {
  const name = /^\/([a-zA-Z0-9_]+)(?:\s|$)/.exec(text.trim())?.[1];
  return AGENT_COMMANDS.find((item) => item.command === name);
}

export async function handleCommand(log: RuntimeLog, options: { promptFile?: string; send: (text: string, update: Update) => Promise<void> }, update: Update, text: string, onStarted?: () => void): Promise<boolean> {
  const receipt = { type: "input_received", chatId: update.userId, messageId: update.messageId };
    if (!update.images?.length && /^\/prompt(?:\s|$)/.test(text)) {
      const changesPrompt = text === "/prompt reset" || text.startsWith("/prompt set ");
      const prompt = text === "/prompt reset" ? undefined : text.slice("/prompt set ".length).trim();
      const events = changesPrompt && (prompt === undefined || prompt)
        ? [receipt, { type: "bot_prompt_config", chatId: update.userId, version: randomUUID(), text: prompt }]
        : [receipt];
      if (log.appendBatch) await log.appendBatch(events);
      else for (const event of events) await log.append(event);
      onStarted?.();
      if (text === "/prompt") {
        const configured = (await log.read()).findLast((e) => e.type === "bot_prompt_config" && e.chatId === update.userId);
        const prompt = typeof configured?.text === "string" ? configured.text :
          (await readFile(options.promptFile ?? resolve("system-prompt.md"), "utf8")).trim();
        await options.send(`当前 bot 提示词：\n${prompt}`, update);
      } else if (text === "/prompt reset" || text.startsWith("/prompt set ")) {
        const prompt = text === "/prompt reset" ? undefined : text.slice("/prompt set ".length).trim();
        if (prompt !== undefined && !prompt) { await options.send("请在 /prompt set 后提供非空提示词。", update); return true; }
        await options.send(prompt === undefined ? "已恢复默认 bot 提示词，下一请求生效。" : "已设置当前聊天的 bot 提示词，下一请求生效。", update);
      } else await options.send("查看：/prompt；设置：/prompt set 提示词；恢复默认：/prompt reset", update);
      return true;
    }
    if (!update.images?.length && text === "/reset") {
      const batch = [{ type: "message", role: "user", text, chatId: update.userId, messageId: update.messageId },
        { type: "reset" }];
      if (log.appendBatch) await log.appendBatch(batch);
      else for (const event of batch) await log.append(event);
      onStarted?.();
      await options.send("已开始新对话，旧记录仍保留在本地。", update);
      return true;
    }
  return false;
}
