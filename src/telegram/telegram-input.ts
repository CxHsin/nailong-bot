import type { Bot } from "grammy";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { Update } from "../application/app-types.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export async function downloadTelegramDocument(bot: Bot, token: string, fileId: string, fetchFile: typeof fetch = fetch): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  if ((file.file_size ?? 0) > MAX_DOCUMENT_BYTES) throw new Error("附件超过 20 MiB 下载限制");
  if (!file.file_path) throw new Error("附件下载失败");
  const response = await fetchFile(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error("附件下载失败");
  if (Number(response.headers.get("content-length")) > MAX_DOCUMENT_BYTES) throw new Error("附件超过 20 MiB 下载限制");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_DOCUMENT_BYTES) { await response.body.cancel().catch(() => {}); throw new Error("附件超过 20 MiB 下载限制"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function downloadTelegramPhoto(bot: Bot, token: string, fileId: string, fetchFile: typeof fetch = fetch): Promise<ImageContent> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path || (file.file_size ?? 0) > MAX_IMAGE_BYTES) throw new Error("图片超过下载限制");
  const response = await fetchFile("https://api.telegram.org/file/bot" + token + "/" + file.file_path,
    { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error("图片下载失败");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_IMAGE_BYTES) throw new Error("图片超过下载限制");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const mimeType = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? "image/jpeg" :
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : undefined;
  if (!mimeType) throw new Error("无法识别图片格式");
  return { type: "image", mimeType, data: bytes.toString("base64") };
}

/** Both text and captioned photos use the same durable acceptance boundary. */
export function registerTelegramInput(bot: Bot, options: {
  ownerId: number;
  botUsername?: string;
  download: (fileId: string) => Promise<ImageContent>;
  document?: (fileId: string, name: string, messageId: number) => Promise<string>;
  handle: (input: Update, onStarted: () => void) => Promise<void>;
  reportFailure: (error?: unknown) => void;
}) {
  const active = new Set<Promise<void>>();
  let acceptance = Promise.resolve();
  bot.on(["message:text", "message:photo", "message:document", "message:sticker"], async (ctx) => {
    if (ctx.from.id !== options.ownerId || ctx.chat.type !== "private" || ctx.chat.id !== options.ownerId) return;
    let text = ctx.message.text ?? ctx.message.caption;
    if (text && options.botUsername) {
      let otherBot = false;
      // Only command tokens in the leading first-line sequence carry bot addressing.
      const leading = /^[\t ]*(?:\/[a-zA-Z0-9_-]+(?::[a-zA-Z0-9-]+)?(?:@[a-zA-Z0-9_]+)?(?=[\t ]|\r?$)(?:[\t ]+|$))+/m.exec(text);
      if (leading?.index === 0) {
        const normalized = leading[0].replace(/(\/[a-zA-Z0-9_-]+(?::[a-zA-Z0-9-]+)?)@([a-zA-Z0-9_]+)/g, (_all, name: string, botName: string) => {
          if (botName.toLowerCase() !== options.botUsername!.toLowerCase()) otherBot = true;
          return name;
        });
        if (otherBot) return;
        text = normalized + text.slice(leading[0].length);
      }
    }
    let releaseAcceptance!: () => void;
    // Include downloads in the shutdown boundary so polling cannot confirm an unaccepted photo.
    acceptance = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
    try {
      let images: ImageContent[] | undefined;
      let runtimeMaterials: string[] | undefined;
      if (ctx.message.document) {
        try {
          if ((ctx.message.document.file_size ?? 0) > MAX_DOCUMENT_BYTES) throw new Error("附件超过 20 MiB 下载限制");
          if (!options.document) throw new Error("附件接收尚未配置");
          runtimeMaterials = [await options.document(ctx.message.document.file_id, ctx.message.document.file_name ?? "attachment", ctx.message.message_id)];
        } catch (error) {
          const detail = error instanceof Error && /^(附件超过|PDF 正文提取失败)/.test(error.message) ? error.message : "附件读取失败";
          await ctx.reply(`${detail}；这条消息尚未开始处理，请检查文件后重新发送。`);
          return;
        }
      }
      if (ctx.message.photo) {
        try { images = [await options.download(ctx.message.photo.at(-1)!.file_id)]; }
        catch {
          await ctx.reply("图片读取失败，请稍后重新发送；这条消息尚未开始处理。");
          return;
        }
      }
      const stickerSets = [...(text ?? "").matchAll(/https?:\/\/(?:t\.me|telegram\.me)\/addstickers\/([a-zA-Z0-9_]+)/g)].map(match=>match[1]!);
      const telegram = {sticker:ctx.message.sticker,replySticker:ctx.message.reply_to_message?.sticker,stickerSets};
      if (telegram.sticker || telegram.replySticker || stickerSets.length)
        runtimeMaterials = [...runtimeMaterials ?? [],`Telegram 素材身份（未自动收录；仅元数据，未理解动态画面）：${JSON.stringify(telegram)}`];
      let markStarted!: () => void;
      let hasStarted = false;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const completed = options.handle({ userId: ctx.from.id, chatType: ctx.chat.type,
        text, images, runtimeMaterials, telegram, messageId: ctx.message.message_id, replyToMessageId: ctx.message.reply_to_message?.message_id,
        ...(ctx.message.reply_to_message ? { replyToMessage: {
          role: ctx.message.reply_to_message.from?.id === ctx.me.id ? "assistant" as const : "user" as const,
          text: ctx.message.reply_to_message.text ?? ctx.message.reply_to_message.caption,
          hasImages: Boolean(ctx.message.reply_to_message.photo?.length),
        } } : {}) },
        () => { hasStarted = true; markStarted(); });
      active.add(completed);
      void completed.then(() => { active.delete(completed); }, (error) => {
        active.delete(completed);
        if (hasStarted) options.reportFailure(error);
      });
      const accepted = Promise.race([started, completed]);
      await accepted;
    } finally { releaseAcceptance(); }
  });
  return { accepted: () => acceptance, async finish() { await Promise.allSettled(active); } };
}
