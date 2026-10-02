import type { Bot } from "grammy";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { Update } from "../application/app-types.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
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
  download: (fileId: string) => Promise<ImageContent>;
  handle: (input: Update, onStarted: () => void) => Promise<void>;
  reportFailure: () => void;
}) {
  const active = new Set<Promise<void>>();
  let acceptance = Promise.resolve();
  bot.on(["message:text", "message:photo"], async (ctx) => {
    if (ctx.from.id !== options.ownerId || ctx.chat.type !== "private") return;
    let releaseAcceptance!: () => void;
    // Include downloads in the shutdown boundary so polling cannot confirm an unaccepted photo.
    acceptance = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
    try {
      let images: ImageContent[] | undefined;
      if (ctx.message.photo) {
        try { images = [await options.download(ctx.message.photo.at(-1)!.file_id)]; }
        catch {
          await ctx.reply("图片读取失败，请稍后重新发送；这条消息尚未开始处理。");
          return;
        }
      }
      let markStarted!: () => void;
      let hasStarted = false;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const completed = options.handle({ userId: ctx.from.id, chatType: ctx.chat.type,
        text: ctx.message.text ?? ctx.message.caption, images, messageId: ctx.message.message_id, replyToMessageId: ctx.message.reply_to_message?.message_id },
        () => { hasStarted = true; markStarted(); });
      active.add(completed);
      void completed.then(() => { active.delete(completed); }, () => {
        active.delete(completed);
        if (hasStarted) options.reportFailure();
      });
      const accepted = Promise.race([started, completed]);
      await accepted;
    } finally { releaseAcceptance(); }
  });
  return { accepted: () => acceptance, async finish() { await Promise.allSettled(active); } };
}
