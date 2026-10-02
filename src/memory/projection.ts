import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { memoryNodes, type MemoryNode } from "../runtime/memory-facts.js";
import { sourceDigest } from "../runtime/event-digest.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { cosineOfUnitVectors, type createEmbeddingClient } from "./embedding.js";

export type MemoryCandidate = { node: MemoryNode; score: number; sources: string[]; similarity?: number };
export function literalTerms(text: string): string[] {
  const parts = text.toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(parts.flatMap((part) => /\p{Script=Han}/u.test(part) && part.length > 1
    ? Array.from({ length: part.length - 1 }, (_, i) => part.slice(i, i + 2)) : [part]))];
}
export function createMemoryProjection(options: { log: RuntimeLog; dataDir: string; userId: number; embedding?: ReturnType<typeof createEmbeddingClient> }) {
  async function nodes(): Promise<MemoryNode[]> {
    const events = await options.log.read();
    const result = memoryNodes(events, options.userId);
    await mkdir(options.dataDir, { recursive: true });
    const db = new DatabaseSync(join(options.dataDir, "memory.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS memory_nodes (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const fingerprint = sourceDigest({ version: 1, userId: options.userId, nodes: result });
      const provenance = JSON.stringify({ version: 1, userId: options.userId, sourceId: events[0]?.eventId ?? sourceDigest(events[0] ?? null),
        through: events.at(-1)?.sequence ?? events.length, prefixDigest: sourceDigest(events) });
      const previous = db.prepare("SELECT value FROM memory_meta WHERE key='source'").get() as { value: string } | undefined;
      const cached = db.prepare("SELECT payload FROM memory_nodes ORDER BY rowid").all() as Array<{ payload: string }>;
      let validCache = false;
      try { validCache = sourceDigest(cached.map((row) => JSON.parse(row.payload))) === sourceDigest(result); }
      catch { validCache = false; }
      if (previous?.value !== fingerprint || !validCache) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec("DELETE FROM memory_nodes");
          const insert = db.prepare("INSERT INTO memory_nodes VALUES (?, ?)");
          for (const node of result) insert.run(node.id, JSON.stringify(node));
          db.prepare("INSERT OR REPLACE INTO memory_meta VALUES ('source', ?)").run(fingerprint);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
      db.prepare("INSERT OR REPLACE INTO memory_meta VALUES ('provenance', ?)").run(provenance);
      return (db.prepare("SELECT payload FROM memory_nodes ORDER BY rowid").all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as MemoryNode);
    } finally { db.close(); }
  }
  async function search(query: string, limit = 20, excludeRequest?: string): Promise<MemoryCandidate[]> {
    if (!query.trim()) return [];
    const all = (await nodes()).filter((n) => n.requestId !== excludeRequest);
    const embedding = options.embedding;
    let queryVector: number[] | undefined;
    if (embedding) {
      try { queryVector = await embedding.get(query); } catch { queryVector = undefined; }
      embedding.enqueue(all.flatMap((node) => node.messages.map((message) => ({ text: message.text,
        eligible: async () => memoryNodes(await options.log.read(), options.userId).some((current) => current.id === node.id),
      }))));
    }
    const terms = literalTerms(query);
    const documents = all.map((n) => new Set(literalTerms(n.messages.map((m) => m.text).join("\n"))));
    return all.map((node, i) => {
      const matched = terms.filter((term) => documents[i]!.has(term));
      const literal = matched.reduce((sum, term) => sum + Math.log(1 + all.length / (1 + documents.filter((d) => d.has(term)).length)), 0);
      const vectors = node.messages.map((message) => embedding?.cached(message.text)).filter((vector): vector is number[] => !!vector);
      const turn = embedding?.turn(node.messages.map((message) => message.text));
      const similarity = queryVector ? Math.max(0, ...vectors.map((vector) => cosineOfUnitVectors(queryVector!, vector)), turn ? cosineOfUnitVectors(queryVector, turn) : 0) : 0;
      const direct = similarity >= 0.35 ? similarity : 0;
      const normalizedLiteral = literal / (1 + literal);
      const score = direct + normalizedLiteral * (1 - direct);
      return { node, score, similarity, sources: [...(literal ? ["literal"] : []), ...(direct ? ["dense"] : [])] };
    }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id)).slice(0, Math.min(72, Math.max(1, limit)));
  }
  return { nodes, search, diagnostics: () => options.embedding ? options.embedding.status() : "embedding_not_configured" };
}
