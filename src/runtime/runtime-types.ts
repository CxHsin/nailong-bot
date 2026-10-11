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

/** Durable bytes and their provenance, independent of any Context Projection implementation. */
export type RecordedToolProjection = {
  content: ToolResult["content"];
  details: unknown;
  sourceDigest: string;
  digest: string;
};

export interface RuntimeLog {
  bytes(): Promise<number>;
  read(): Promise<StoredEvent[]>;
  append(event: Omit<StoredEvent, "at">): Promise<unknown>;
  appendBatch?(events: Array<Omit<StoredEvent, "at">>): Promise<unknown>;
  readSince?(afterSequence: number): Promise<StoredEvent[]>;
  archive(result: ToolResult): Promise<ToolArchive>;
  loadArchive(archive: ToolArchive): Promise<ToolResult>;
  recoverArchive(archive: ToolArchive, source?: ToolResult): Promise<ToolResult>;
  isArchiveRead(toolName: string, args: unknown): boolean;
}
