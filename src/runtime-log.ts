import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

export type StoredEvent = {
  type: string;
  at: string;
  requestId?: string;
  [key: string]: unknown;
};

export type ToolResult = {
  content: unknown;
  details: unknown;
  isError: boolean;
};

function readableResult(result: ToolResult): string {
  const serialized = JSON.stringify(result);
  // Each line is a bounded, lossless fragment. Concatenating its `text` fields
  // reconstructs the exact JSON stored in the raw archive.
  return (serialized.match(/[\s\S]{1,3000}/g) ?? [""])
    .map((part, index) => JSON.stringify({ part: index + 1, text: part })).join("\n");
}

export function createRuntimeLog(dataDir: string) {
  const eventFile = join(dataDir, "events.jsonl");
  const archiveDir = join(dataDir, "tool-results");

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
    isArchiveRead(toolName: string, args: unknown): boolean {
      if (toolName !== "read" || typeof args !== "object" || args === null || !("path" in args) ||
        typeof args.path !== "string") return false;
      return args.path.startsWith(archiveDir) && args.path.endsWith(".txt");
    },
  };
}

export type RuntimeLog = ReturnType<typeof createRuntimeLog>;
