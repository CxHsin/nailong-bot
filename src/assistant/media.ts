import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type MediaOutput = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type MediaSource = string | Record<string, string>;
export type MediaEntry = { order: number; type: string; mimeType?: string; uri?: string; path?: string; bytes?: number };
export type MediaManifest = { version: 1; source: MediaSource; entries: MediaEntry[]; delegated: boolean; path: string };
export type MediaOptions = { batchImages?: number; maxInlineBytes?: number };

/** Persist originals before projecting media into the main model's input. */
export async function persistMedia(directory: string, content: readonly unknown[], source: MediaSource, options: MediaOptions = {}): Promise<{
  output: MediaOutput[]; manifest?: MediaManifest;
}> {
  const output: MediaOutput[] = [];
  const entries: MediaEntry[] = [];
  const originals: Array<{ entry: MediaEntry; data: Buffer; extension: string }> = [];
  let imageCount = 0;
  let binaryBytes = 0;
  for (const [index, value] of content.entries()) {
    if (!value || typeof value !== "object") continue;
    const part = value as Record<string, unknown>;
    const order = index + 1;
    if (part.type === "text" && typeof part.text === "string") { output.push({ type: "text", text: part.text }); continue; }
    if ((part.type === "image" || part.type === "audio") && typeof part.data === "string" && typeof part.mimeType === "string") {
      const data = Buffer.from(part.data, "base64");
      const entry = { order, type: part.type, mimeType: part.mimeType, bytes: data.length };
      entries.push(entry);
      originals.push({ entry, data, extension: extension(part.mimeType) });
      binaryBytes += data.length;
      if (part.type === "image") {
        imageCount++;
        output.push({ type: "image", data: part.data, mimeType: part.mimeType });
      }
      continue;
    }
    if (part.type === "resource_link" && typeof part.uri === "string") {
      const entry: MediaEntry = { order, type: "resource_link", uri: part.uri,
        ...(typeof part.mimeType === "string" ? { mimeType: part.mimeType } : {}) };
      entries.push(entry);
      output.push({ type: "text", text: `Resource: ${part.uri}${typeof part.name === "string" ? ` (${part.name})` : ""}` });
      continue;
    }
    if (part.type === "resource" && part.resource && typeof part.resource === "object") {
      const resource = part.resource as Record<string, unknown>;
      const entry: MediaEntry = { order, type: "resource", ...(typeof resource.uri === "string" ? { uri: resource.uri } : {}),
        ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}) };
      entries.push(entry);
      if (typeof resource.text === "string") {
        const data = Buffer.from(resource.text, "utf8");
        entry.bytes = data.length;
        originals.push({ entry, data, extension: "txt" });
      } else if (typeof resource.blob === "string") {
        const data = Buffer.from(resource.blob, "base64");
        entry.bytes = data.length;
        originals.push({ entry, data, extension: extension(entry.mimeType ?? "") });
        binaryBytes += data.length;
        if (entry.mimeType?.startsWith("image/")) imageCount++;
      }
    }
  }
  if (!entries.length) return { output };
  const identity = createHash("sha256").update(JSON.stringify({ source, content })).digest("hex");
  const root = resolve(directory, identity);
  await mkdir(root, { recursive: true });
  for (const original of originals) {
    original.entry.path = join(root, `${String(original.entry.order).padStart(3, "0")}.${original.extension}`);
    await writeFile(original.entry.path, original.data);
  }
  const delegated = imageCount >= (options.batchImages ?? 3) || binaryBytes > (options.maxInlineBytes ?? 512 * 1024);
  const manifest: MediaManifest = { version: 1, source, entries, delegated, path: join(root, "manifest.json") };
  await writeFile(manifest.path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const projected = delegated ? output.filter((part) => part.type !== "image") : output;
  const preview = entries.slice(0, 3).map((entry) => `${entry.order}. ${entry.type}: ${entry.path ?? entry.uri ?? "metadata only"}${entry.path && entry.uri ? ` (source ${entry.uri})` : ""}`).join("\n");
  projected.push({ type: "text", text: `${delegated ? "Batch media routed before main-model input." : "Media originals saved."} Manifest: ${manifest.path}\n${preview}${entries.length > 3 ? `\n${entries.length} ordered materials total; remaining paths are in the manifest.` : ""}${delegated ? "\nUse a helper for this material: pass the subtask goal and manifest path; reuse the same helper identity for follow-ups. The helper reads originals using its own file tools and returns a concise conclusion, unresolved questions and selected evidence paths. Read selected evidence only when needed. Confirm access to any live browser session before assigning browser work." : ""}` });
  return { output: projected, manifest };
}

function extension(mimeType: string) {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
    "audio/wav": "wav", "audio/mpeg": "mp3", "application/pdf": "pdf", "text/plain": "txt" } as Record<string, string>)[mimeType] ?? "bin";
}
