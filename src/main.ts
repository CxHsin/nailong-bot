import { resolve } from "node:path";
import { Bot } from "grammy";
import { createPiAgent } from "./agent/pi-agent.js";
import { createSqliteRuntimeLog } from "./runtime/sqlite-runtime-log.js";
import { createHost } from "./host/host.js";
import { createTelegramHostProjection, createTelegramRichTransport, normalizeTelegramInput, telegramEnvironment } from "./channel/telegram/index.js";
import { registerTelegramInput, downloadTelegramPhoto } from "./telegram/telegram-input.js";
import type { Update } from "./application/app-types.js";

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
  const log = createSqliteRuntimeLog(dataDir);
  await log.importLegacy();
  const agent = await createPiAgent({ dataDir, promptFile, deepseekKey, tinyfishKey: process.env.TINYFISH_API_KEY?.trim() });
  const bot = new Bot(telegram.token);
  const transport = createTelegramRichTransport({
    sendRich: async (chatId, markdown) => (await bot.api.sendRichMessage(chatId, { markdown })).message_id,
    draftRich: async (draftId, chatId, markdown) => { await bot.api.sendRichMessageDraft(chatId, draftId, { markdown }); },
    sendHtml: async (chatId, html) => (await bot.api.sendMessage(chatId, html, { parse_mode: "HTML" })).message_id,
    draftHtml: async (draftId, chatId, html) => { await bot.api.sendMessageDraft(chatId, draftId, html, { parse_mode: "HTML" }); },
  });
  const host = createHost({ log, execute: async (input, context) => {
    const text = input.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "请分析这张图片。";
    const images = input.parts.filter((part): part is { type: "image"; mimeType: string; data?: string } => part.type === "image" && !!part.data)
      .map((part) => ({ type: "image" as const, mimeType: part.mimeType, data: part.data! }));
    await log.append({ type: "message", role: "user", text, requestId: context.runId, conversationId: input.conversationId, ...(images.length ? { images } : {}) });
    await log.append({ type: "request_started", requestId: context.runId, conversationId: input.conversationId });
    context.emit({ type: "progress", phase: "agent", source: "runtime", visibility: "normal", contextPolicy: "exclude", text: "处理中" });
    const messages = (await log.read()).filter((event) => event.type === "message" && (event.role === "user" || event.role === "assistant"))
      .map((event) => ({ role: event.role as "user" | "assistant", text: String(event.text ?? "") }));
    const answer = await agent.answer(messages, { id: context.runId, log });
    await log.append({ type: "answer_generated", requestId: context.runId, text: answer, resultId: context.runId });
    return { text: answer, resultId: context.runId };
  } });
  const projection = createTelegramHostProjection({ ...transport, chatId: telegram.ownerId,
    onDelivered: async (event) => {
      await log.append({ type: "delivery_succeeded", runId: event.runId, requestId: event.runId, resultId: String(event.result?.resultId ?? event.runId), channel: "telegram" });
      await log.append({ type: "request_completed", requestId: event.runId });
    },
  });
  const handle = async (update: Update, started: () => void) => {
    const image = update.images?.[0];
    const input = normalizeTelegramInput({ fromId: update.userId, chatId: update.userId, chatType: update.chatType,
      messageId: update.messageId, text: update.text, image: image ? { mimeType: image.mimeType, data: image.data } : undefined });
    const run = host.submit(input);
    started();
    await projection.consume(run);
  };
  const reportFailure = (error?: unknown) => {
    console.error("Telegram 更新处理失败，请检查连接和本地记录。", error instanceof Error ? error.stack ?? error.message : error);
  };
  const input = registerTelegramInput(bot, { ownerId: telegram.ownerId,
    download: (fileId) => downloadTelegramPhoto(bot, telegram.token, fileId), handle, reportFailure });
  bot.catch((error) => reportFailure(error));
  const stop = () => { void input.accepted().then(() => bot.stop()).catch(reportFailure); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  console.log("Agent 正在通过 Telegram Channel 接收私聊文字和图片消息。");
  try { await bot.start({ limit: 1, drop_pending_updates: false }); }
  finally { await input.finish(); await agent.close(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
