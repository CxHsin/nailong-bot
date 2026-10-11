export function telegramEnvironment(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): { token: string; ownerId: number } {
  const token = env.AGENT_TELEGRAM_BOT_TOKEN?.trim() || env.TELEGRAM_BOT_TOKEN?.trim();
  const owner = env.AGENT_TELEGRAM_USER_ID?.trim() || env.TELEGRAM_USER_ID?.trim();
  if (!token) throw new Error("缺少 Telegram bot token");
  const ownerId = Number(owner);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error("Telegram ownerId 必须是正整数");
  if (!env.AGENT_TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN) warn("TELEGRAM_* 环境变量已兼容；迁移到 AGENT_TELEGRAM_*。");
  return { token, ownerId };
}
