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
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks.map((block: unknown) => {
    if (typeof block === "object" && block !== null && "type" in block && block.type === "text" &&
      "text" in block && typeof block.text === "string") return block.text;
    return "[Non-text tool result block; see the original JSON archive.]";
  }).join("\n\n");
  // The built-in read tool is line-based and rejects a single very long line.
  return (text.match(/[\s\S]{1,3000}/g) ?? [""]).join("\n");
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
      const sha256 = createHash("sha256").update(serialized).digest("hex");
      const id = randomUUID();
      const rawPath = join(archiveDir, `${id}.json`);
      const path = join(archiveDir, `${id}.txt`);
      await mkdir(archiveDir, { recursive: true });
      for (const [target, body] of [[rawPath, serialized], [path, readableResult(result)]] as const) {
        const file = await open(target, "wx");
        try { await file.writeFile(body, "utf8"); await file.sync(); }
        finally { await file.close(); }
      }
      const actual = createHash("sha256").update(await readFile(rawPath)).digest("hex");
      if (actual !== sha256) throw new Error("工具结果归档校验失败");
      return { path, rawPath, bytes: Buffer.byteLength(serialized), sha256 };
    },
    isArchiveRead(toolName: string, args: unknown): boolean {
      if (toolName !== "read" || typeof args !== "object" || args === null || !("path" in args) ||
        typeof args.path !== "string") return false;
      return args.path.startsWith(archiveDir) && args.path.endsWith(".txt");
    },
  };
}

export type RuntimeLog = ReturnType<typeof createRuntimeLog>;
