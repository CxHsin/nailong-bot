import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Actor, HostInputLike, RunHandle } from "../host/host.js";
import { normalizeHostInput } from "../host/host.js";
import type { ContentPart } from "../host/content-parts.js";
import type { HostEvent } from "../host/host.js";

export type CliCommand = { command: "chat" | "send"; text?: string; conversationId?: string; json: boolean; imagePath?: string };
export function parseCliArgs(argv: string[]): CliCommand {
  const command = argv[0] === "chat" || argv[0] === "send" ? argv[0] : "chat";
  let text: string | undefined; let conversationId: string | undefined; let json = false; let imagePath: string | undefined;
  for (let index = command === "chat" || command === "send" ? 1 : 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--json" || value === "--ndjson") json = true;
    else if (value === "--conversation-id") conversationId = argv[++index];
    else if (value === "--image") imagePath = argv[++index];
    else text = text ? `${text} ${value}` : value;
  }
  return { command, ...(text ? { text } : {}), ...(conversationId ? { conversationId } : {}), json, ...(imagePath ? { imagePath } : {}) };
}

function jsonEvent(event: HostEvent) {
  return { type: event.type, seq: event.sequence, sequence: event.sequence, runId: event.runId, conversationId: event.conversationId,
    ...(event.phase ? { phase: event.phase } : {}), ...(event.source ? { source: event.source } : {}),
    ...(event.text ? { text: event.text } : {}), ...(event.progress ? { progress: event.progress } : {}),
    ...(event.result ? { result: event.result } : {}), ...(event.error ? { error: event.error } : {}) };
}
function humanEvent(event: HostEvent): string | undefined {
  if (event.type === "progress") {
    const progress = event.progress;
    if (!progress) return event.text;
    if (progress.type === "text") return progress.finalized && progress.kind !== "final" ?
      `${progress.source === "progress-model" ? "运行摘要：" : ""}${progress.text}` : undefined;
    if (progress.type === "discard") return undefined;
    return `[tool:${progress.state}] ${progress.name}`;
  }
  if (event.type === "run_succeeded") return `run_succeeded ${event.result?.text ?? ""}`.trim();
  if (event.type === "run_failed") return `run_failed ${event.error ?? ""}`.trim();
  return event.type;
}

export function createCliChannel(options: { host: { submit(input: HostInputLike): RunHandle }; actor: Actor; stdout: (line: string) => void; stderr: (line: string) => void; defaultConversationId?: string; onDelivered?: (event: HostEvent) => Promise<void> }) {
  const sessionId = options.defaultConversationId ?? `cli:${options.actor.id}`;
  async function inputParts(text: string | undefined, imagePath?: string): Promise<ContentPart[]> {
    const parts: ContentPart[] = [];
    if (text?.trim()) parts.push({ type: "text", text });
    if (imagePath) {
      const bytes = await readFile(imagePath);
      const lower = imagePath.toLowerCase();
      const mimeType = lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : "image/jpeg";
      parts.push({ type: "image", mimeType, data: bytes.toString("base64"), contentRef: `file:${basename(imagePath)}` });
    }
    return parts;
  }
  async function consume(handle: RunHandle, json: boolean): Promise<HostEvent> {
    for await (const event of handle.events()) {
      const line = json ? JSON.stringify(jsonEvent(event)) : humanEvent(event);
      if (line !== undefined) options.stdout(line);
      if (event.type === "run_succeeded") await options.onDelivered?.(event);
    }
    return handle.done;
  }
  async function send(text: string | undefined, settings: { json?: boolean; conversationId?: string; imagePath?: string } = {}): Promise<HostEvent> {
    const conversationId = settings.conversationId ?? sessionId;
    const parts = await inputParts(text, settings.imagePath);
    const input = normalizeHostInput({ actor: options.actor, conversationId, parts });
    try { return await consume(options.host.submit(input), settings.json ?? false); }
    catch (error) { options.stderr(`CLI error: ${String(error)}`); throw error; }
  }
  async function chat(lines: AsyncIterable<string> | Iterable<string>, settings: { json?: boolean; conversationId?: string } = {}) {
    const results: HostEvent[] = [];
    for await (const line of lines) results.push(await send(line, settings));
    return results;
  }
  return { send, chat, inputParts };
}
