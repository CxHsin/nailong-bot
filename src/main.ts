import { resolve } from "node:path";
import { Bot, GrammyError } from "grammy";
import { createApp, DeliveryRejected } from "./app.js";
import { createPiAgent } from "./pi-agent.js";
import { createSqliteRuntimeLog } from "./sqlite-runtime-log.js";
import { formatMarkdownForTelegram } from "./telegram-format.js";

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
  const agent = await createPiAgent({
    dataDir,
    promptFile,
    deepseekKey,
    tinyfishKey: process.env.TINYFISH_API_KEY?.trim(),
    modelBudgetRatios: process.env.PROJECTION_BUDGET_RATIOS
      ? JSON.parse(process.env.PROJECTION_BUDGET_RATIOS) : undefined,
  });
  const bot = new Bot(token);
  const app = createApp({
    ownerId,
    dataDir,
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
    send: async (text, update, onChunk) => {
      const chunks = text.match(/[\s\S]{1,4000}/g) ?? [];
      for (const [index, chunk] of chunks.entries()) {
        try { await bot.api.sendMessage(update.userId, formatMarkdownForTelegram(chunk), { parse_mode: "HTML" }); }
        catch (error) {
          if (error instanceof GrammyError) throw new DeliveryRejected(`Telegram 拒绝发送：${error.error_code}`);
          throw error;
        }
        await onChunk?.(index + 1, chunks.length);
      }
    },
  });
  await app.recover();
  const activeRequests = new Set<Promise<void>>();
  let currentAcceptance = Promise.resolve();
  const reportUpdateFailure = () => console.error("Telegram 更新处理失败，请检查连接和本地记录。");
  bot.on("message:text", async (ctx) => {
    let markStarted!: () => void;
    let hasStarted = false;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const completed = app.handle({
      userId: ctx.from.id,
      chatType: ctx.chat.type,
      text: ctx.message.text,
      messageId: ctx.message.message_id,
    }, () => { hasStarted = true; markStarted(); });
    activeRequests.add(completed);
    void completed.then(() => { activeRequests.delete(completed); }, () => {
      activeRequests.delete(completed);
      if (hasStarted) reportUpdateFailure();
    });
    // Poll again after the input is durable, while execution stays serialized by the app.
    // A queued input holds this middleware until its own durable start.
    const accepted = Promise.race([started, completed]);
    currentAcceptance = accepted.catch(() => undefined);
    await accepted;
  });
  bot.catch(reportUpdateFailure);
  // bot.stop confirms the current update; wait until a queued input is durable first.
  const stop = () => { void currentAcceptance.then(() => bot.stop()).catch(reportUpdateFailure); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Bot 正在通过 Telegram long polling 接收私聊文字消息。");
  try { await bot.start({ limit: 1, drop_pending_updates: false }); }
  finally { await Promise.allSettled(activeRequests); await agent.close(); }
}

main().catch((error) => {
  const message = (error as Error).message;
  console.error(message.startsWith("缺少环境变量") || message.startsWith("TELEGRAM_USER_ID")
    ? message : "启动或运行失败，请检查服务配置、连接及 System prompt 文件。");
  process.exitCode = 1;
});
