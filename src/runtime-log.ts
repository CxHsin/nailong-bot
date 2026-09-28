import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
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

export function readableResult(result: ToolResult): string {
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
    async bytes(): Promise<number> {
      try { return (await stat(eventFile)).size; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
    },
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
      return this.recoverArchive(archive);
    },
    async recoverArchive(archive: ToolArchive, source?: ToolResult): Promise<ToolResult> {
      if (source) await mkdir(archiveDir, { recursive: true });
      const root = await realpath(archiveDir);
      const entries = [[archive.rawPath, archive.rawBytes, archive.rawSha256],
        [archive.path, archive.bytes, archive.sha256]] as const;
      for (const [path] of entries) {
        const inside = relative(root, resolve(path));
        if (!inside || inside.startsWith("..") || isAbsolute(inside) ||
          !/^[0-9a-f-]{36}\.(json|txt)$/.test(inside)) throw new Error("工具归档位置不受信任");
      }
      const expected = source && [JSON.stringify(source), readableResult(source)];
      if (expected && entries.some(([, bytes, sha256], index) =>
        Buffer.byteLength(expected[index]!) !== bytes ||
        createHash("sha256").update(expected[index]!).digest("hex") !== sha256)) {
        throw new Error("工具归档与事件结果不一致");
      }
      const bodies: string[] = [];
      for (const [index, [path, bytes, sha256]] of entries.entries()) {
        let body: string | undefined;
        try {
          const actual = await realpath(path);
          if (relative(root, actual).startsWith("..") || isAbsolute(relative(root, actual))) {
            throw new Error("工具归档位置不受信任");
          }
          body = await readFile(actual, "utf8");
        } catch (error) {
          if ((error as Error).message === "工具归档位置不受信任") throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !source) throw error;
        }
        if (body === undefined || Buffer.byteLength(body) !== bytes ||
          createHash("sha256").update(body).digest("hex") !== sha256) {
          const replacement = expected?.[index];
          if (replacement === undefined || Buffer.byteLength(replacement) !== bytes ||
            createHash("sha256").update(replacement).digest("hex") !== sha256) {
            throw new Error("工具归档缺失或校验失败");
          }
          const temp = `${path}.${randomUUID()}.tmp`;
          try {
            const file = await open(temp, "wx");
            try { await file.writeFile(replacement, "utf8"); await file.sync(); }
            finally { await file.close(); }
            await rename(temp, path);
          } finally { await rm(temp, { force: true }); }
          body = replacement;
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
      const pathname = args.path.split("#", 1)[0]!;
      const inside = relative(archiveDir, resolve(dataDir, pathname));
      return !!inside && !inside.startsWith("..") && !isAbsolute(inside) && pathname.endsWith(".txt");
    },
  };
}

export type RuntimeLog = ReturnType<typeof createRuntimeLog>;
