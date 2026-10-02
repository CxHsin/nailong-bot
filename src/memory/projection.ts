import { memoryNodes, type MemoryNode } from "../runtime/memory-facts.js";
import { sourceDigest } from "../runtime/event-digest.js";
import type { RuntimeLog, StoredEvent } from "../runtime/runtime-types.js";
import { cosineOfUnitVectors, type createEmbeddingClient } from "./embedding.js";
import { graphAt, memoryGraph, type MemoryState, type MemoryInitialization } from "./graph.js";
import { MEMORY_ALGORITHM, memoryDynamics, type MemoryDynamics } from "./dynamics.js";
import { rankMemories, recallConfig, type RecallConfig } from "./recall.js";
import { openMemoryCache } from "./cache.js";

export type MemoryCandidate = { node: MemoryNode; score: number; sources: string[]; similarity?: number; state?: MemoryState; initialization?: MemoryInitialization; paths?: string[][] };
export function literalTerms(text: string): string[] {
  const parts = text.toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(parts.flatMap((part) => /\p{Script=Han}/u.test(part) && part.length > 1
    ? Array.from({ length: part.length - 1 }, (_, i) => part.slice(i, i + 2)) : [part]))];
}
export type MemoryMode = "akasha" | "dense";
export function createMemoryProjection(options: { log: RuntimeLog; dataDir: string; userId: number; embedding?: ReturnType<typeof createEmbeddingClient>; dynamics?: Partial<MemoryDynamics>; now?: () => number; recall?: Partial<RecallConfig>; mode?: MemoryMode }) {
  const mode = options.mode ?? "akasha";
  const dynamics = memoryDynamics(options.dynamics);
  let cacheRebuilt = false;
  async function nodes(source?: StoredEvent[]): Promise<MemoryNode[]> {
    const events = source ?? await options.log.read();
    const result = memoryNodes(events, options.userId);
    const cache = openMemoryCache(options.dataDir, "memory");
    const db = cache.db; cacheRebuilt ||= cache.recovered;
    try {
      const fingerprint = sourceDigest({ version: 1, userId: options.userId, nodes: result });
      const provenance = JSON.stringify({ version: 1, userId: options.userId, sourceId: events[0]?.eventId ?? sourceDigest(events[0] ?? null),
        through: events.at(-1)?.sequence ?? events.length, prefixDigest: sourceDigest(events) });
      const previous = db.prepare("SELECT value FROM memory_meta WHERE key='source'").get() as { value: string } | undefined;
      const consumed = db.prepare("SELECT value FROM memory_meta WHERE key='provenance'").get() as { value: string } | undefined;
      const cached = db.prepare("SELECT payload FROM memory_nodes ORDER BY rowid").all() as Array<{ payload: string }>;
      let validCache = false;
      try { validCache = sourceDigest(cached.map((row) => JSON.parse(row.payload))) === sourceDigest(result); }
      catch { validCache = false; }
      if (previous?.value !== fingerprint || consumed?.value !== provenance || !validCache) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec("DELETE FROM memory_nodes");
          const insert = db.prepare("INSERT INTO memory_nodes VALUES (?, ?)");
          for (const node of result) insert.run(node.id, JSON.stringify(node));
          db.prepare("INSERT OR REPLACE INTO memory_meta VALUES ('source', ?)").run(fingerprint);
          db.prepare("INSERT OR REPLACE INTO memory_meta VALUES ('provenance', ?)").run(provenance);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
      return (db.prepare("SELECT payload FROM memory_nodes ORDER BY rowid").all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as MemoryNode);
    } finally { db.close(); }
  }
  async function search(query: string, limit = 20, excludeRequest?: string): Promise<MemoryCandidate[]> {
    if (!query.trim()) return [];
    const events = await options.log.read();
    const all = (await nodes(events)).filter((n) => n.requestId !== excludeRequest);
    const embedding = options.embedding;
    let queryVector: number[] | undefined;
    if (embedding) {
      try { queryVector = await embedding.get(query); } catch { queryVector = undefined; }
      embedding.enqueue(all.flatMap((node) => node.messages.map((message) => ({ text: message.text,
        eligible: async () => memoryNodes(await options.log.read(), options.userId).some((current) => current.id === node.id),
      }))));
    }
    const terms = mode === "dense" ? [] : literalTerms(query);
    const documents = mode === "dense" ? [] : all.map((n) => new Set(literalTerms(n.messages.map((m) => m.text).join("\n"))));
    const content = all.map((node, i) => {
      const matched = terms.filter((term) => documents[i]!.has(term));
      const literal = matched.reduce((sum, term) => sum + Math.log(1 + all.length / (1 + documents.filter((d) => d.has(term)).length)), 0);
      const vectors = node.messages.map((message) => embedding?.cached(message.text)).filter((vector): vector is number[] => !!vector);
      const turn = embedding?.turn(node.messages.map((message) => message.text));
      const similarity = queryVector ? Math.max(0, ...vectors.map((vector) => cosineOfUnitVectors(queryVector!, vector)), turn ? cosineOfUnitVectors(queryVector, turn) : 0) : 0;
      const direct = similarity >= 0.35 ? similarity : 0;
      const normalizedLiteral = literal / (1 + literal);
      const evidence = direct + normalizedLiteral * (1 - direct);
      const userEvidence = mode !== "dense" && node.messages.some((message) => message.role === "user" && (literalTerms(message.text).some((term) => terms.includes(term)) ||
        queryVector && embedding?.cached(message.text) && cosineOfUnitVectors(queryVector, embedding.cached(message.text)!) >= 0.35));
      return { node, evidence, similarity, userEvidence, sources: [...(literal ? ["literal"] : []), ...(direct ? ["dense"] : [])] };
    });
    if (mode === "dense") return content.filter((item) => item.similarity >= 0.35)
      .sort((left, right) => right.similarity - left.similarity || left.node.id.localeCompare(right.node.id))
      .slice(0, Math.min(72, Math.max(1, limit))).map((item) => ({ node: item.node, score: item.similarity, similarity: item.similarity, sources: ["dense"] }));
    const baseGraph = memoryGraph(events, options.userId, (text) => embedding?.cached(text), dynamics);
    const { db } = openMemoryCache(options.dataDir, "memory");
    try {
      db.prepare("INSERT OR REPLACE INTO memory_meta VALUES ('graph', ?)").run(JSON.stringify({ algorithm: MEMORY_ALGORITHM, userId: options.userId,
        sourceDigest: sourceDigest(events), through: events.at(-1)?.sequence ?? events.length, embedding: embedding?.namespace(), dynamics,
        states: [...baseGraph.states.values()], edges: [...baseGraph.edges.values()] }));
    } finally { db.close(); }
    const graph = graphAt(baseGraph, options.now?.() ?? Date.now(), dynamics);
    return rankMemories(content, graph, dynamics, recallConfig(options.recall)).slice(0, Math.min(72, Math.max(1, limit)))
      .map((item) => ({ ...item, initialization: baseGraph.initializations.find((entry) => entry.nodeId === item.node.id) }));
  }
  return { nodes, search, mode, dynamics, diagnostics: () => [cacheRebuilt ? "memory_index_rebuilt" : undefined,
    options.embedding ? options.embedding.status() : "embedding_not_configured"].filter(Boolean).join(",") || undefined };
}
