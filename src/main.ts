import { resolve } from "node:path";
import { Bot, GrammyError } from "grammy";
import { createApp, DeliveryRejected } from "./app.js";
import { createPiAgent } from "./pi-agent.js";

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
    answer: agent.answer,
    send: async (text, update, onChunk) => {
      const chunks = text.match(/[\s\S]{1,4000}/g) ?? [];
      for (const [index, chunk] of chunks.entries()) {
        try { await bot.api.sendMessage(update.userId, chunk); }
        catch (error) {
          if (error instanceof GrammyError) throw new DeliveryRejected(`Telegram 拒绝发送：${error.error_code}`);
          throw error;
        }
        await onChunk?.(index + 1, chunks.length);
      }
    },
  });
  bot.on("message:text", async (ctx) => {
    await app.handle({
      userId: ctx.from.id,
      chatType: ctx.chat.type,
      text: ctx.message.text,
      messageId: ctx.message.message_id,
    });
  });
  bot.catch(() => console.error("Telegram 更新处理失败，请检查连接和本地记录。"));
  const stop = () => bot.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Bot 正在通过 Telegram long polling 接收私聊文字消息。");
  try { await bot.start({ drop_pending_updates: false }); }
  finally { await agent.close(); }
}

main().catch((error) => {
  const message = (error as Error).message;
  console.error(message.startsWith("缺少环境变量") || message.startsWith("TELEGRAM_USER_ID")
    ? message : "启动或运行失败，请检查服务配置、连接及 System prompt 文件。");
  process.exitCode = 1;
});
