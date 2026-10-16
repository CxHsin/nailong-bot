import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export type ToolArchiveLimits = {
  thresholdBytes: number; previewBytes: number; readBytes: number; maxReadBytes: number;
  readLines: number; maxReadLines: number; searchLimit: number; maxSearchLimit: number; searchBytes: number;
};
/** Fits below Pi's 50 KiB retained output while leaving room for provenance and status. */
export const DEFAULT_TOOL_ARCHIVE_LIMITS: Readonly<ToolArchiveLimits> = {
  thresholdBytes: 16 * 1024, previewBytes: 4 * 1024, readBytes: 8 * 1024, maxReadBytes: 32 * 1024,
  readLines: 100, maxReadLines: 500, searchLimit: 10, maxSearchLimit: 50, searchBytes: 8 * 1024,
};
type Call = { id: string; name: string; arguments: object };
type IndexEntry = { ref: string; callId: string; tool: string; time: string; status: "success" | "error";
  command: string; arguments: string; files: string[]; inputIds: string[]; bytes: number; progressBytes: number; view: string };
function bounded(text: string, bytes: number) {
  const buffer = Buffer.from(text); let end = Math.min(buffer.length, bytes);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}
function countLines(text: string) { return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0; }
function preview(text: string, bytes: number, isError?: boolean) {
  if (!isError || Buffer.byteLength(text) <= bytes) return bounded(text, bytes);
  const errorLines = text.split("\n").filter((line) => /error|fail|exception|exit.{0,12}[1-9]/i.test(line)).slice(-3).join("\n");
  const evidence = Buffer.from(errorLines || text); let start = Math.max(0, evidence.length - Math.floor(bytes / 2));
  while (start < evidence.length && (evidence[start]! & 0xc0) === 0x80) start++;
  return `${bounded(text, Math.floor(bytes / 2))}\n[error evidence]\n${evidence.subarray(start).toString("utf8")}`;
}
function positive(value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER, minimum = 1) {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(Math.trunc(value!), maximum)) : fallback;
}
function json(value: object): ToolExecutionResult { return { output: [{ type: "text", text: JSON.stringify(value) }] }; }
function failure(code: string, error: unknown): ToolExecutionResult {
  return { isError: true, output: [{ type: "text", text: JSON.stringify({ error: code, message: bounded(String(error), 512) }) }] };
}

/** Originals and their small searchable metadata share the Conversation's durable data lifetime. */
export function createToolArchive(options: { directory: string; conversationId: string; limits?: Partial<ToolArchiveLimits> }) {
  const configured = options.limits ?? {};
  const limits = Object.fromEntries(Object.entries(DEFAULT_TOOL_ARCHIVE_LIMITS).map(([key, value]) =>
    [key, positive(configured[key as keyof ToolArchiveLimits], value)])) as ToolArchiveLimits;
  limits.previewBytes = Math.min(limits.previewBytes, 8192);
  limits.maxReadBytes = Math.max(4, Math.min(limits.maxReadBytes, 32768));
  limits.maxReadLines = Math.min(limits.maxReadLines, 500);
  limits.maxSearchLimit = Math.min(limits.maxSearchLimit, 50);
  limits.searchBytes = Math.max(2048, Math.min(limits.searchBytes, 16384));
  const directory = options.directory;
  const id = (callId: string) => createHash("sha256").update(`${options.conversationId}\0${callId}`).digest("hex");
  const path = (key: string, extension: string) => join(directory, `${key}.${extension}`);
  const progress = new Map<string, { shown: number; hidden: boolean; error?: unknown }>();
  async function entries(): Promise<IndexEntry[]> {
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return Promise.all(names.filter((name) => name.endsWith(".index.json")).sort().map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as IndexEntry));
  }
  function progressView(callId: string, text: string) {
    let state = progress.get(callId);
    if (!state) { state = { shown: 0, hidden: false }; progress.set(callId, state); }
    try { mkdirSync(directory, { recursive: true }); appendFileSync(path(id(callId), "progress.txt"), text); }
    catch (error) { state.error = error; }
    const visible = bounded(text, Math.max(0, limits.previewBytes - state.shown)); state.shown += Buffer.byteLength(visible);
    if (visible.length === text.length || state.hidden) return visible;
    state.hidden = true;
    return `${visible}\n[Further progress withheld; final result will report durable archive status.]`;
  }
  async function capture(call: Call, result: ToolExecutionResult, inputIds: string[] = []): Promise<ToolExecutionResult> {
    if (call.name.startsWith("archive_")) return result;
    const key = id(call.id);
    const currentText = (result.output ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (currentText.includes(`archive:${key}`)) return result;
    const shell = result.structuredOutput && typeof result.structuredOutput === "object" && !Array.isArray(result.structuredOutput) ? result.structuredOutput : undefined;
    const spill = typeof shell?.fullOutputPath === "string" ? shell.fullOutputPath : result.diagnostics?.find((item) => item.code === "full_output")?.message.replace(/^Full output: /, "");
    let text = currentText; let progressText = "";
    const state = progress.get(call.id);
    try {
      if (state?.error) throw state.error;
      try { progressText = await readFile(path(key, "progress.txt"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (spill) text = await readFile(spill, "utf8");
      const bytes = Buffer.byteLength(text);
      if (!spill && bytes <= limits.thresholdBytes && Buffer.byteLength(progressText) <= limits.thresholdBytes) return result;
      await mkdir(directory, { recursive: true });
      try {
        const existing = JSON.parse(await readFile(path(key, "index.json"), "utf8")) as IndexEntry;
        return { ...result, output: [{ type: "text", text: existing.view }, ...(result.output ?? []).filter((part) => part.type !== "text")] };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const status = result.isError ? "error" : "success";
      const exit = typeof shell?.exitCode === "number" ? `; exitCode=${shell.exitCode}` : "";
      const diagnostics = bounded((result.diagnostics ?? []).map((entry) => `${entry.code ?? entry.severity}: ${entry.message}`).join("\n"), 512);
      const ref = `archive:${key}`;
      const view = `[Tool output archived; status=${status}${exit}; bytes=${bytes}; progressBytes=${Buffer.byteLength(progressText)}]\n${ref}\nRead with archive_read({ref:${JSON.stringify(ref)}}); unknown references: archive_search.\n${diagnostics}\n${preview(text || progressText, limits.previewBytes, result.isError)}`;
      const argumentText = JSON.stringify(call.arguments);
      const args = call.arguments as Record<string, unknown>;
      const entry: IndexEntry = { ref, callId: call.id, tool: call.name, time: new Date().toISOString(), status,
        command: bounded(typeof args.command === "string" ? args.command : "", 512), arguments: bounded(argumentText, 1024),
        files: Object.entries(args).filter(([key, value]) => /path|file/i.test(key) && typeof value === "string").map(([, value]) => bounded(String(value), 512)),
        inputIds, bytes, progressBytes: Buffer.byteLength(progressText), view };
      await writeFile(path(key, "txt"), text);
      await writeFile(path(key, "result.json"), JSON.stringify(result));
      // Publish discovery only after both original forms are durable.
      await writeFile(path(key, "index.json"), JSON.stringify(entry));
      return { ...result, output: [{ type: "text", text: view }, ...(result.output ?? []).filter((part) => part.type !== "text")] };
    } catch (error) {
      const status = result.isError ? "error" : "success";
      return { ...result, output: [{ type: "text", text: `[Archive failed; tool status=${status}. Execution already occurred; do not repeat effects to recover output. No readable archive reference.]\n${bounded(String(error), 256)}\n${preview(text, limits.previewBytes, result.isError)}` }, ...(result.output ?? []).filter((part) => part.type !== "text")] };
    } finally { progress.delete(call.id); }
  }
  function tools(): ToolRegistration[] {
    return [defineTool({ name: "archive_search", replay: "safe", description:
      "Find prior long tool evidence in this Conversation, including after reset/compaction/restart. Known archive reference: use archive_read directly. Unknown reference: search by keyword, tool, command, file or time. Returns bounded metadata only; never automatically reads pages.",
      parameters: Type.Object({ query: Type.Optional(Type.String()), tool: Type.Optional(Type.String()), command: Type.Optional(Type.String()), file: Type.Optional(Type.String()),
        after: Type.Optional(Type.String()), before: Type.Optional(Type.String()), status: Type.Optional(Type.Union([Type.Literal("success"), Type.Literal("error")])),
        cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1 })) }),
      async execute(args) {
        try {
          const all = await entries(); const matched: IndexEntry[] = [];
          for (const entry of all.sort((a, b) => a.time.localeCompare(b.time) || a.ref.localeCompare(b.ref))) {
            if (args.tool && entry.tool !== args.tool || args.command && !entry.command.includes(args.command) || args.file && !entry.files.some((file) => file.includes(args.file!)) ||
              args.after && entry.time < args.after || args.before && entry.time > args.before || args.status && entry.status !== args.status) continue;
            if (args.query) {
              const metadata = JSON.stringify(entry).toLowerCase();
              if (!metadata.includes(args.query.toLowerCase())) {
                // Missing originals remain discoverable as metadata, but cannot match their unavailable body.
                let original = ""; try { original = await readFile(path(entry.ref.slice(8), "txt"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
                if (!original.toLowerCase().includes(args.query.toLowerCase())) continue;
              }
            }
            matched.push(entry);
          }
          const start = args.cursor ?? 0; const limit = positive(args.limit, limits.searchLimit, limits.maxSearchLimit);
          const items: object[] = [];
          for (const entry of matched.slice(start, start + limit)) {
            const candidate = { ref: entry.ref, callId: bounded(entry.callId, 128), tool: bounded(entry.tool, 128), time: entry.time, status: entry.status,
              command: bounded(entry.command, 256), match: bounded(entry.arguments, 256), files: entry.files.slice(0, 4).map((file) => bounded(file, 128)),
              inputIds: entry.inputIds.slice(0, 4).map((inputId) => bounded(inputId, 128)), bytes: entry.bytes, progressBytes: entry.progressBytes,
              read: { tool: "archive_read", ref: entry.ref } };
            if (items.length && Buffer.byteLength(JSON.stringify([...items, candidate])) > limits.searchBytes) break;
            items.push(candidate);
          }
          return json({ scope: options.conversationId, query: bounded(JSON.stringify(args), 512), items, total: matched.length, truncated: start + items.length < matched.length,
            ...(start + items.length < matched.length ? { next: start + items.length } : {}) });
        } catch (error) { return failure("archive_index_unavailable", error); }
      } }), defineTool({ name: "archive_read", replay: "safe", description:
      "Read exactly one bounded page of archived text, or its progress stream. Both line and UTF-8 byte ceilings apply. Continue only if needed using returned next (offset and byteOffset); byteOffset advances within long single lines without losing characters. Does not prefetch. Missing original is reported explicitly.",
      parameters: Type.Object({ ref: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), byteOffset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1 })), maxBytes: Type.Optional(Type.Integer({ minimum: 4 })), stream: Type.Optional(Type.Union([Type.Literal("output"), Type.Literal("progress")])) }),
      async execute(args) {
        if (!/^archive:[a-f0-9]{64}$/.test(args.ref)) return failure("invalid_archive_reference", "Expected an archive reference returned by archive_search or a tool result");
        const key = args.ref.slice(8);
        try {
          // Require Conversation metadata, so a reference from a different Conversation cannot escape its namespace.
          await readFile(path(key, "index.json"), "utf8");
          const file = await open(path(key, args.stream === "progress" ? "progress.txt" : "txt"), "r");
          try {
            const totalBytes = (await file.stat()).size;
            if ((args.byteOffset ?? 0) > totalBytes) return failure("invalid_archive_cursor", "Cursor is beyond the original");
            let start = 0; let startLine = 1;
            const targetLine = args.offset ?? 1;
            const scan = Buffer.alloc(64 * 1024);
            // Scan only the prefix needed to find a line or count an explicit byte cursor's line.
            while (args.byteOffset === undefined ? startLine < targetLine && start < totalBytes : start < args.byteOffset) {
              const remaining = args.byteOffset === undefined ? totalBytes - start : args.byteOffset - start;
              const { bytesRead } = await file.read(scan, 0, Math.min(scan.length, remaining), start);
              if (!bytesRead) break;
              let used = bytesRead;
              for (let position = 0; position < bytesRead; position++) if (scan[position] === 10) {
                startLine++;
                if (args.byteOffset === undefined && startLine === targetLine) { used = position + 1; break; }
              }
              start += used;
            }
            const lineLimit = positive(args.limit, limits.readLines, limits.maxReadLines);
            const byteLimit = positive(args.maxBytes, limits.readBytes, limits.maxReadBytes, 4);
            const buffer = Buffer.alloc(Math.min(byteLimit + 1, totalBytes - start));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
            if (bytesRead && (buffer[0]! & 0xc0) === 0x80) return failure("invalid_archive_cursor", "Cursor must be on a UTF-8 character boundary");
            let length = Math.min(bytesRead, byteLimit);
            while (length > 0 && length < bytesRead && (buffer[length]! & 0xc0) === 0x80) length--;
            let lines = 0;
            for (let position = 0; position < length; position++) if (buffer[position] === 10 && ++lines === lineLimit) { length = position + 1; break; }
            const text = buffer.subarray(0, length).toString("utf8");
            const end = start + length; const nextLine = startLine + text.split("\n").length - 1;
            return json({ ref: args.ref, stream: args.stream ?? "output", text, bytes: length, lines: countLines(text), fromByte: start, toByte: end,
              startLine, endLine: Math.max(startLine, nextLine - (text.endsWith("\n") ? 1 : 0)), totalBytes, hasMore: end < totalBytes,
              ...(end < totalBytes ? { next: { offset: nextLine, byteOffset: end } } : {}) });
          } finally { await file.close(); }
        } catch (error) { return failure((error as NodeJS.ErrnoException).code === "ENOENT" ? "archive_original_missing" : "archive_read_failed", error); }
      } })];
  }
  return { capture, progress: progressView, tools, limits };
}
