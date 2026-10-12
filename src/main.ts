import { Bot } from 'grammy';
import { createPersonalRuntime } from './personal/runtime.js';
import { createPersonalTelegram } from './personal/telegram.js';
import { telegramEnvironment } from './channel/telegram/index.js';
import { downloadTelegramPhoto } from './telegram/telegram-input.js';

async function main() {
  const telegram = telegramEnvironment(process.env);
  const runtime = await createPersonalRuntime();
  const bot = new Bot(telegram.token, { client: { timeoutSeconds: 30 } });
  const reportFailure = (error: unknown) => console.error(error instanceof Error ? error.message : String(error));
  const channel = createPersonalTelegram({ bot, ownerId: telegram.ownerId, host: runtime.host,
    download: fileId => downloadTelegramPhoto(bot, telegram.token, fileId), onDelivered: runtime.onDelivered, reportFailure });
  let tickTail = Promise.resolve();
  const timer = setInterval(() => {
    tickTail = tickTail.then(async () => { await runtime.plans.tick(); await channel.recover(); }).catch(reportFailure);
  }, 1000);
  timer.unref();
  bot.catch(error => reportFailure(error.error));
  const stop = () => { void bot.stop().catch(reportFailure); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await bot.init();
    await bot.api.setMyCommands([{ command: 'help', description: '查看使用方式' }, { command: 'reset', description: '重置主对话上下文' },
      { command: 'forget', description: '排除指定记忆来源' }, { command: 'memory', description: '查询长期记忆' }, { command: 'model', description: '查看或切换模型' }],
    { scope: { type: 'chat', chat_id: telegram.ownerId } }).catch(reportFailure);
    await channel.recover();
    console.log('Personal Host 正在接收 Telegram 私聊；后台任务独立执行。');
    await bot.start({ limit: 1, drop_pending_updates: false });
  } finally {
    clearInterval(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await channel.finish(); await tickTail; await channel.close(); await runtime.close();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
