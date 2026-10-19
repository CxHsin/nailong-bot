import { Bot } from "grammy";
import { telegramEnvironment } from "../channel/telegram/index.js";
import { downloadTelegramPhoto, downloadTelegramDocument } from "../telegram/telegram-input.js";
import { assistantEnvironment } from "./environment.js";
import { connectTelegram } from "./telegram.js";
import type { Assistant } from "./runtime.js";

/** Production initialization and shutdown, with injectable external Telegram and model boundaries. */
export async function createTelegramService(options: {
  bot: Bot;
  runtime: { app: Assistant; dataDir: string; close(): Promise<void> };
  ownerId: number;
  download: Parameters<typeof connectTelegram>[0]["download"];
  downloadDocument?: Parameters<typeof connectTelegram>[0]["downloadDocument"];
  reportFailure: (error: unknown) => void;
  startupTimeoutMs?: number;
}) {
  const { bot, runtime, ownerId, reportFailure } = options;
  const shutdown = new AbortController();
  let channel: Awaited<ReturnType<typeof connectTelegram>> | undefined;
  bot.catch((error) => reportFailure(error.error));
  try {
    await bot.init();
    channel = await connectTelegram({ ...options, app: runtime.app, dataDir: runtime.dataDir });
    await bot.api.setMyCommands(
      [
        { command: "start", description: "打开会话控制面板" },
        { command: "help", description: "使用方式" },
        { command: "kvcache", description: "查看最近五轮 prompt cache 用量" },
        { command: "feed", description: "投喂奶龙" },
        { command: "reset", description: "重置会话上下文，保留工作" },
        { command: "model", description: "查看或切换模型" },
        { command: "thinking", description: "调整当前模型思考等级" },
        { command: "work", description: "查看工作与目标操作" },
        { command: "session", description: "会话操作" },
        { command: "draft", description: "开关草稿预览" },
        { command: "stop", description: "暂停当前请求，保留进度" },
        { command: "resume", description: "继续暂停工作" },
      ],
      { scope: { type: "chat", chat_id: ownerId } },
    );
  } catch (error) {
    await runtime.close();
    await channel?.close({ waitForIdle: false });
    throw error;
  }
  const activeChannel = channel;
  const startup = runtime.app.startupGreeting(`telegram:private:${ownerId}`,
    { signal: shutdown.signal, timeoutMs: options.startupTimeoutMs }).then(async result => {
    if (shutdown.signal.aborted || result.status === "cancelled") return result;
    const text = result.status === "success"
      ? `${result.text}\n（启动测试模型：${result.model}；思考：${result.thinking ?? "off"}）`
      : result.status === "unavailable"
        ? "奶龙服务已启动，尚无可用主模型，未进行模型测试。请打开 /start 连接 Magpie 并选择主模型。"
        : `奶龙服务已启动，但启动模型测试未通过${result.model ? `（${result.model}）` : ""}：${result.reason}。控制面板和接收输入仍可用。`;
    try { await activeChannel.sendStartup(text, result.id); }
    catch { /* Send Receipt records rejection or ambiguity; no retry or service restart. */ }
    return result;
  });
  let closing: Promise<void> | undefined;
  return {
    channel: activeChannel,
    startup,
    run() { return bot.start({ limit: 1, drop_pending_updates: false }); },
    close() {
      if (closing) return closing;
      shutdown.abort(new Error("Telegram 服务关闭"));
      closing = (async () => {
        if (bot.isRunning()) await bot.stop();
        await activeChannel.accepted();
        await activeChannel.finish();
        try { await runtime.close(); }
        finally { await activeChannel.close({ waitForIdle: false }); }
        await startup;
      })();
      return closing;
    },
  };
}

export async function startTelegram() {
  const telegram = telegramEnvironment(process.env);
  const runtime = await assistantEnvironment();
  const bot = new Bot(telegram.token, { client: { timeoutSeconds: 30 } });
  const reportFailure = (error: unknown) => console.error(error instanceof Error ? error.message : String(error));
  const service = await createTelegramService({ bot, runtime, ownerId: telegram.ownerId,
    download: id => downloadTelegramPhoto(bot, telegram.token, id),
    downloadDocument: id => downloadTelegramDocument(bot, telegram.token, id), reportFailure });
  const stop = () => { void service.close().catch(reportFailure); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    console.log("持久队列与 Pi Durable 助手正在接收 Telegram 私聊。");
    await service.run();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await service.close();
  }
}
