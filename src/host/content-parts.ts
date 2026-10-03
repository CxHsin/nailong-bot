import type { ImageContent } from "@mariozechner/pi-ai";

export type TextContentPart = { type: "text"; text: string };
export type ImageContentPart = {
  type: "image";
  mimeType: string;
  /** Base64 data or a durable content reference. Channel file IDs never cross this boundary. */
  data?: string;
  contentRef?: string;
  width?: number;
  height?: number;
};
export type ContentPart = TextContentPart | ImageContentPart;

function imagePart(value: unknown): ImageContentPart {
  if (!value || typeof value !== "object") throw new Error("image ContentPart 无效");
  const image = value as Partial<ImageContentPart> & { source?: unknown; fileId?: unknown };
  const mimeType = image.mimeType;
  if (typeof mimeType !== "string" || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
    throw new Error("image ContentPart 缺少有效 MIME 类型");
  }
  const data = typeof image.data === "string" ? image.data : undefined;
  const contentRef = typeof image.contentRef === "string" ? image.contentRef :
    typeof image.source === "string" ? image.source : undefined;
  if (!data && !contentRef) throw new Error("image ContentPart 缺少持久化内容引用");
  if (image.fileId !== undefined) throw new Error("Telegram file_id 必须在 Channel 边界解析");
  for (const [name, value] of [["width", image.width], ["height", image.height]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`image ${name} 无效`);
  }
  return { type: "image", mimeType, ...(data ? { data } : {}), ...(contentRef ? { contentRef } : {}),
    ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}) };
}

export function normalizeContentParts(value: unknown): ContentPart[] {
  const parts: unknown[] = typeof value === "string" ? [{ type: "text", text: value }] :
    Array.isArray(value) ? value : value && typeof value === "object" && "parts" in value && Array.isArray((value as { parts?: unknown }).parts)
      ? (value as { parts: unknown[] }).parts : [];
  const normalized = parts.map((part): ContentPart => {
    if (!part || typeof part !== "object") throw new Error("ContentPart 无效");
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text") {
      if (typeof candidate.text !== "string" || !candidate.text.trim()) throw new Error("text ContentPart 不能为空");
      return { type: "text", text: candidate.text };
    }
    if (candidate.type === "image") return imagePart(part);
    throw new Error("ContentPart 类型不支持");
  });
  if (!normalized.length) throw new Error("至少需要一个 ContentPart");
  return normalized;
}
