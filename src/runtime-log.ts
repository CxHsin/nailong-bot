import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolResultMessage } from "@mariozechner/pi-ai";

export type StoredEvent = {
  type: string;
  at: string;
  requestId?: string;
  [key: string]: unknown;
};

export type ToolResult = {
  content: ToolResultMessage["content"];
  details: unknown;
  isError: boolean;
};
export type ToolArchive = { path: string; bytes: number; sha256: string;
  rawPath: string; rawBytes: number; rawSha256: string };

export function archivePlaceholder(toolName: string, archive: ToolArchive): ToolResult["content"] {
  return [{ type: "text", text: `工具结果已归档。工具：${toolName}；路径：${archive.path}；字节数：${archive.bytes}；SHA-256：${archive.sha256}。可用 read 按 offset/limit 分段读取 JSONL；各行按 part 排序并拼接 text，可还原完整原始结果 JSON。` }];
}

export function shouldPrune(result: ToolResult, archiveRead: boolean): boolean {
  return !archiveRead && result.content.every((block) => block.type === "text") &&
    JSON.stringify(result).length / 4 > 2048;
}

function readableResult(result: ToolResult): string {
  const serialized = JSON.stringify(result);
  // Each line is a bounded, lossless fragment. Concatenating its `text` fields
  // reconstructs the exact JSON stored in the raw archive.
  return (serialized.match(/[\s\S]{1,3000}/g) ?? [""])
    .map((part, index) => JSON.stringify({ part: index + 1, text: part })).join("\n");
}

export function createRuntimeLog(dataDir: string) {
  const eventFile = join(dataDir, "events.jsonl");
  const archiveDir = resolve(dataDir, "tool-results");

  return {
    async read(): Promise<StoredEvent[]> {
      let content: string;
      try { content = await readFile(eventFile, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as StoredEvent);
    },
    async append(event: Omit<StoredEvent, "at">): Promise<void> {
      await mkdir(dataDir, { recursive: true });
      const file = await open(eventFile, "a");
      try {
        await file.writeFile(`${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, "utf8");
        await file.sync();
      } finally { await file.close(); }
    },
    async archive(result: ToolResult) {
      const serialized = JSON.stringify(result);
      const rawSha256 = createHash("sha256").update(serialized).digest("hex");
      const readable = readableResult(result);
      const sha256 = createHash("sha256").update(readable).digest("hex");
      const id = randomUUID();
      const rawPath = join(archiveDir, `${id}.json`);
      const path = join(archiveDir, `${id}.txt`);
      await mkdir(archiveDir, { recursive: true });
      for (const [target, body] of [[rawPath, serialized], [path, readable]] as const) {
        const file = await open(target, "wx");
        try { await file.writeFile(body, "utf8"); await file.sync(); }
        finally { await file.close(); }
      }
      const actualRaw = createHash("sha256").update(await readFile(rawPath)).digest("hex");
      const actualReadable = createHash("sha256").update(await readFile(path)).digest("hex");
      if (actualRaw !== rawSha256 || actualReadable !== sha256) throw new Error("工具结果归档校验失败");
      return { path, bytes: Buffer.byteLength(readable), sha256,
        rawPath, rawBytes: Buffer.byteLength(serialized), rawSha256 };
    },
    async loadArchive(archive: ToolArchive): Promise<ToolResult> {
      const root = await realpath(archiveDir);
      const bodies: string[] = [];
      for (const [path, bytes, sha256] of [[archive.rawPath, archive.rawBytes, archive.rawSha256],
        [archive.path, archive.bytes, archive.sha256]] as const) {
        const actual = await realpath(path);
        const inside = relative(root, actual);
        if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("工具归档位置不受信任");
        const body = await readFile(actual, "utf8");
        if (Buffer.byteLength(body) !== bytes || createHash("sha256").update(body).digest("hex") !== sha256) {
          throw new Error("工具归档校验失败");
        }
        bodies.push(body);
      }
      const result: ToolResult = JSON.parse(bodies[0]!);
      if (!Array.isArray(result.content) || typeof result.isError !== "boolean") throw new Error("工具归档格式错误");
      return result;
    },
    isArchiveRead(toolName: string, args: unknown): boolean {
      if (toolName !== "read" || typeof args !== "object" || args === null || !("path" in args) ||
        typeof args.path !== "string") return false;
      const inside = relative(archiveDir, resolve(dataDir, args.path));
      return !!inside && !inside.startsWith("..") && !isAbsolute(inside) && args.path.endsWith(".txt");
    },
  };
}

export type RuntimeLog = ReturnType<typeof createRuntimeLog>;
