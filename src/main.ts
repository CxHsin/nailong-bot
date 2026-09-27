import { resolve } from "node:path";
import { Bot } from "grammy";
import { createApp } from "./app.js";
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
  });
  const bot = new Bot(token);
  const app = createApp({
    ownerId,
    dataDir,
    answer: agent.answer,
    reset: agent.reset,
    send: async (text, update) => {
      for (const chunk of text.match(/[\s\S]{1,4000}/g) ?? []) await bot.api.sendMessage(update.userId, chunk);
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
  bot.catch((error) => console.error("Telegram 更新处理失败：", error.message));
  const stop = () => bot.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Bot 正在通过 Telegram long polling 接收私聊文字消息。");
  try { await bot.start({ drop_pending_updates: false }); }
  finally { await agent.close(); }
}

main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
