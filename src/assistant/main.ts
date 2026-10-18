import { Bot } from "grammy";
import { telegramEnvironment } from "../channel/telegram/index.js";
import { downloadTelegramPhoto, downloadTelegramDocument } from "../telegram/telegram-input.js";
import { assistantEnvironment } from "./environment.js";
import { connectTelegram } from "./telegram.js";

export async function startTelegram() {
  const telegram = telegramEnvironment(process.env);
  const runtime = await assistantEnvironment();
  const bot = new Bot(telegram.token, { client: { timeoutSeconds: 30 } });
  const reportFailure = (error: unknown) =>
    console.error(error instanceof Error ? error.message : String(error));
  const stop = () => {
    void bot.stop().catch(reportFailure);
  };
  let channel: Awaited<ReturnType<typeof connectTelegram>> | undefined;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  bot.catch((error) => reportFailure(error.error));
  try {
    await bot.init();
    channel = await connectTelegram({
      app: runtime.app,
      bot,
      ownerId: telegram.ownerId,
      dataDir: runtime.dataDir,
      download: (id) => downloadTelegramPhoto(bot, telegram.token, id),
      downloadDocument: (id) => downloadTelegramDocument(bot, telegram.token, id),
      reportFailure,
    });
    await bot.api.setMyCommands(
      [
        { command: "start", description: "打开会话控制面板" },
        { command: "help", description: "使用方式" },
        { command: "kvcache", description: "查看最近五轮 prompt cache 用量" },
        { command: "reset", description: "重置会话上下文，保留工作" },
        { command: "model", description: "查看或切换模型" },
        { command: "thinking", description: "调整当前模型思考等级" },
        { command: "work", description: "查看工作与目标操作" },
        { command: "session", description: "会话操作" },
        { command: "draft", description: "开关草稿预览" },
        { command: "stop", description: "暂停当前请求，保留进度" },
        { command: "resume", description: "继续暂停工作" },
      ],
      { scope: { type: "chat", chat_id: telegram.ownerId } },
    );
    console.log("持久队列与 Pi Durable 助手正在接收 Telegram 私聊。");
    await bot.start({ limit: 1, drop_pending_updates: false });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await channel?.accepted();
    await channel?.finish();
    await runtime.close();
    await channel?.close();
  }
}
