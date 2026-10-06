import { resolve } from "node:path";
import { Bot } from "grammy";
import { createPiAgent } from "./agent/pi-agent.js";
import { gptEnvironment } from "./agent/model-config.js";
import { createRuntimeEventLog } from "./runtime/event-log.js";
import { createAgentHost } from "./application/agent-host.js";
import { createTelegramRichTransport, telegramEnvironment } from "./channel/telegram/index.js";
import { initializeTelegramHostChannel } from "./channel/telegram/host-channel.js";
import { downloadTelegramPhoto } from "./telegram/telegram-input.js";
import { memoryDynamics } from "./memory/dynamics.js";
import { recallConfig } from "./memory/recall.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}；请参照 .env.example 配置 .env`);
  return value;
}

async function main(): Promise<void> {
  const telegram = telegramEnvironment(process.env);
  const deepseekKey = required("DEEPSEEK_API_KEY");
  const dataDir = resolve(process.env.AGENT_DATA_DIR?.trim() || "data");
  const promptFile = resolve(process.env.AGENT_PROMPT_FILE?.trim() || "system-prompt.md");
  const log = await createRuntimeEventLog(dataDir);
  const dynamics = memoryDynamics(process.env.MEMORY_DYNAMICS ? JSON.parse(process.env.MEMORY_DYNAMICS) : undefined);
  const recall = recallConfig(process.env.MEMORY_RECALL ? JSON.parse(process.env.MEMORY_RECALL) : undefined);
  if (!process.env.EMBEDDING_BASE_URL?.trim() || !process.env.EMBEDDING_MODEL?.trim() || !process.env.EMBEDDING_API_KEY?.trim())
    console.error("Embedding 配置不完整，语义记忆未启用；普通聊天与字面记忆查询仍可使用。");
  const agent = await createPiAgent({
    dataDir,
    promptFile,
    deepseekKey,
    gpt: gptEnvironment(process.env),
    tinyfishKey: process.env.TINYFISH_API_KEY?.trim(),
    embedding: process.env.EMBEDDING_BASE_URL?.trim() && process.env.EMBEDDING_MODEL?.trim() && process.env.EMBEDDING_API_KEY?.trim() ? {
      baseUrl: process.env.EMBEDDING_BASE_URL, model: process.env.EMBEDDING_MODEL, apiKey: process.env.EMBEDDING_API_KEY,
      timeoutMs: process.env.EMBEDDING_TIMEOUT_MS ? Number(process.env.EMBEDDING_TIMEOUT_MS) : undefined,
      maxInputChars: process.env.EMBEDDING_MAX_INPUT_CHARS ? Number(process.env.EMBEDDING_MAX_INPUT_CHARS) : undefined,
    } : undefined,
    modelBudgetRatios: process.env.PROJECTION_BUDGET_RATIOS
      ? JSON.parse(process.env.PROJECTION_BUDGET_RATIOS) : undefined,
    memoryBudget: { maxTokens: process.env.MEMORY_MAX_TOKENS ? Number(process.env.MEMORY_MAX_TOKENS) : undefined },
    memoryDynamics: dynamics, memoryRecall: recall,
  });
  const bot = new Bot(telegram.token);
  // grammY's Node types use a legacy AbortSignal declaration; its runtime accepts
  // the native signal's aborted/addEventListener/removeEventListener contract.
  const transport = createTelegramRichTransport({
    sendRich: async (chatId, markdown) => (await bot.api.sendRichMessage(chatId, { markdown })).message_id,
    draftRich: async (draftId, chatId, markdown, signal) => { await bot.api.sendRichMessageDraft(chatId, draftId, { markdown }, undefined, signal as Parameters<typeof bot.api.sendRichMessageDraft>[4]); },
    editHtml: async (messageId, chatId, html) => { await bot.api.editMessageText(chatId, messageId, html, { parse_mode: "HTML" }); },
    sendHtml: async (chatId, html) => (await bot.api.sendMessage(chatId, html, { parse_mode: "HTML" })).message_id,
    draftHtml: async (draftId, chatId, html, signal) => { await bot.api.sendMessageDraft(chatId, draftId, html, { parse_mode: "HTML" }, signal as Parameters<typeof bot.api.sendMessageDraft>[4]); },
  });
  const host = createAgentHost({ log, dataDir, promptFile, agent,
    progressSummary: process.env.PROGRESS_SUMMARY_OPTIONS ? JSON.parse(process.env.PROGRESS_SUMMARY_OPTIONS) : undefined });
  await host.recoverInterrupted();
  const reportFailure = (error?: unknown) => {
    console.error("Telegram 更新处理失败，请检查连接和本地记录。", error instanceof Error ? error.stack ?? error.message : error);
  };
  const channel = await initializeTelegramHostChannel({ bot, ownerId: telegram.ownerId, host, transport,
    download: (fileId) => downloadTelegramPhoto(bot, telegram.token, fileId), reportFailure,
    onDelivered: (event, telegramMessageId) => host.recordDelivery(event, { channel: "telegram", telegramMessageId }) });
  const stop = () => { void channel.stop().catch(reportFailure); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  console.log("Agent 正在通过 Telegram Channel 接收私聊文字和图片消息。");
  try { await channel.start(); }
  finally { await agent.close(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
