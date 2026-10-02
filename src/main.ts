import { resolve } from "node:path";
import { Bot, GrammyError } from "grammy";
import { createApp, DeliveryRejected } from "./application/app.js";
import { createPiAgent } from "./agent/pi-agent.js";
import { createSqliteRuntimeLog } from "./runtime/sqlite-runtime-log.js";
import { planTelegramText } from "./telegram/telegram-layout.js";
import { registerTelegramInput, downloadTelegramPhoto } from "./telegram/telegram-input.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}；请参照 .env.example 配置 .env`);
  return value;
}

async function main(): Promise<void> {
  const token = required("TELEGRAM_BOT_TOKEN");
  const deepseekKey = required("DEEPSEEK_API_KEY");
  const ownerId = Number(required("TELEGRAM_USER_ID"));
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error("TELEGRAM_USER_ID 必须是正整数");
  const dataDir = resolve("data");
  const promptFile = resolve("system-prompt.md");
  const log = createSqliteRuntimeLog(dataDir);
  await log.importLegacy();
  if (!process.env.EMBEDDING_BASE_URL?.trim() || !process.env.EMBEDDING_MODEL?.trim() || !process.env.EMBEDDING_API_KEY?.trim())
    console.error("Embedding 配置不完整，语义记忆未启用；普通聊天与字面记忆查询仍可使用。");
  const agent = await createPiAgent({
    dataDir,
    promptFile,
    deepseekKey,
    tinyfishKey: process.env.TINYFISH_API_KEY?.trim(),
    embedding: process.env.EMBEDDING_BASE_URL?.trim() && process.env.EMBEDDING_MODEL?.trim() && process.env.EMBEDDING_API_KEY?.trim() ? {
      baseUrl: process.env.EMBEDDING_BASE_URL, model: process.env.EMBEDDING_MODEL, apiKey: process.env.EMBEDDING_API_KEY,
      timeoutMs: process.env.EMBEDDING_TIMEOUT_MS ? Number(process.env.EMBEDDING_TIMEOUT_MS) : undefined,
    } : undefined,
    modelBudgetRatios: process.env.PROJECTION_BUDGET_RATIOS
      ? JSON.parse(process.env.PROJECTION_BUDGET_RATIOS) : undefined,
  });
  const bot = new Bot(token);
  const app = createApp({
    ownerId,
    dataDir,
    promptFile,
    log,
    telegram: {
      draft: async (draftId, text, chatId, parseMode) => {
        try { await bot.api.sendMessageDraft(chatId, draftId, text,
          parseMode ? { parse_mode: parseMode } : undefined); }
        catch (error) {
          if (error instanceof GrammyError) throw new DeliveryRejected(`Telegram 拒绝草稿：${error.error_code}`,
            error.parameters.retry_after === undefined ? undefined : error.parameters.retry_after * 1000);
          throw error;
        }
      },
      send: async (text, chatId, parseMode) => {
        try { return (await bot.api.sendMessage(chatId, text,
          parseMode ? { parse_mode: parseMode } : undefined)).message_id; }
        catch (error) {
          if (error instanceof GrammyError) throw new DeliveryRejected(`Telegram 拒绝发送：${error.error_code}`,
            error.parameters.retry_after === undefined ? undefined : error.parameters.retry_after * 1000);
          throw error;
        }
      },
      edit: async (messageId, text, chatId, parseMode) => {
        try { await bot.api.editMessageText(chatId, messageId, text,
          parseMode ? { parse_mode: parseMode } : undefined); }
        catch (error) {
          if (error instanceof GrammyError && /message is not modified/i.test(error.description)) return;
          if (error instanceof GrammyError) throw new DeliveryRejected(`Telegram 拒绝编辑：${error.error_code}`,
            error.parameters.retry_after === undefined ? undefined : error.parameters.retry_after * 1000);
          throw error;
        }
      },
      isRejected: (error) => error instanceof DeliveryRejected,
      retryAfter: (error) => error instanceof DeliveryRejected ? error.retryAfterMs : undefined,
    },
    answer: agent.answer,
    memoryVector: agent.memoryVector,
    purgeEmbeddingCache: agent.purgeEmbeddingCache,
    send: async (text, update, onChunk) => {
      const chunks = planTelegramText(text);
      for (const [index, chunk] of chunks.entries()) {
        try { await bot.api.sendMessage(update.userId, chunk, { parse_mode: "HTML" }); }
        catch (error) {
          if (error instanceof GrammyError) throw new DeliveryRejected(`Telegram 拒绝发送：${error.error_code}`);
          throw error;
        }
        await onChunk?.(index + 1, chunks.length);
      }
    },
  });
  await app.recover();
  const reportUpdateFailure = () => console.error("Telegram 更新处理失败，请检查连接和本地记录。");
  const input = registerTelegramInput(bot, { ownerId,
    download: (fileId) => downloadTelegramPhoto(bot, token, fileId),
    handle: (update, started) => app.handle(update, started), reportFailure: reportUpdateFailure });
  bot.catch(reportUpdateFailure);
  // bot.stop confirms the current update; wait until a queued input is durable first.
  const stop = () => { void input.accepted().then(() => bot.stop()).catch(reportUpdateFailure); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Bot 正在通过 Telegram long polling 接收私聊文字和图片消息。");
  try { await bot.start({ limit: 1, drop_pending_updates: false }); }
  finally { await input.finish(); await agent.close(); }
}

main().catch((error) => {
  const message = (error as Error).message;
  console.error(message.startsWith("缺少环境变量") || message.startsWith("TELEGRAM_USER_ID")
    ? message : "启动或运行失败，请检查服务配置、连接及 System prompt 文件。");
  process.exitCode = 1;
});
