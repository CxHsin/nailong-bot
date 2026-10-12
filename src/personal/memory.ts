import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryProjection } from '../memory/projection.js';
import { memoryTools } from '../memory/tools.js';
import { memoryNodes, type MemoryNode } from '../runtime/memory-facts.js';
import type { RuntimeLog, StoredEvent } from '../runtime/runtime-types.js';
import { invalidateMemoryIndex } from '../memory/cache.js';
import { createEmbeddingClient, type EmbeddingConfig } from '../memory/embedding.js';
import type { MemoryDynamics } from '../memory/dynamics.js';
import type { RecallConfig } from '../memory/recall.js';
import { memoryGraph } from '../memory/graph.js';
import { MEMORY_ALGORITHM, learningSignal, memoryDynamics } from '../memory/dynamics.js';
import { persistMemoryLearning } from '../application/memory-learning.js';
import { conversationLog, conversationEvents, conversationUserId } from '../runtime/conversation-log.js';

export type PersonalMemory = ReturnType<typeof createPersonalMemory>;
export function memoryActor(actorId: string): number {
  return conversationUserId(actorId);
}

/** Memory-only durable records; task state and Pi exchanges never flow through this source. */
export function createPersonalMemory(options: {
  dataDir: string; historical?: Pick<RuntimeLog, 'read'>; embedding?: EmbeddingConfig;
  dynamics?: Partial<MemoryDynamics>; recall?: Partial<RecallConfig>;
  invalidateSessions: (conversationId: string, nodeId: string) => Promise<void>;
}) {
  mkdirSync(options.dataDir, { recursive: true });
  const db = new DatabaseSync(join(options.dataDir, 'personal-memory.sqlite'));
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS memory_records (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS delivered_turns (id TEXT PRIMARY KEY)');
  const embedding = options.embedding ? createEmbeddingClient(options.dataDir, options.embedding) : undefined;
  const shown = new Map<string, Array<{ nodeId: string; score: number; shown: Array<{ nodeId: string; messageId: string; offset: number; end: number }> }>>();
  const read = async (): Promise<StoredEvent[]> => {
    const historical = await options.historical?.read() ?? [];
    const local = (db.prepare('SELECT payload FROM memory_records ORDER BY rowid').all() as Array<{ payload: string }>).map(row => JSON.parse(row.payload) as StoredEvent);
    return [...historical, ...local].map((event, sequence) => ({ ...event, sequence }));
  };
  const append = async (event: Omit<StoredEvent, 'at'>) => {
    const id = randomUUID(); const stored = { ...event, eventId: id, at: new Date().toISOString() };
    db.prepare('INSERT INTO memory_records VALUES (?,?)').run(id, JSON.stringify(stored));
  };
  const log: Pick<RuntimeLog, 'read' | 'append'> = { read, append };
  function projection(actorId: string) {
    return createMemoryProjection({ log: conversationLog(log, actorId), dataDir: options.dataDir, userId: memoryActor(actorId), embedding,
      dynamics: options.dynamics, recall: options.recall });
  }
  return {
    exclusionVersion(conversationId?: string) {
      const rows = (db.prepare('SELECT id,payload FROM memory_records ORDER BY rowid').all() as Array<{ id: string; payload: string }>);
      return rows.filter(row => { const event = JSON.parse(row.payload) as StoredEvent; return event.type === 'memory_excluded' && (!conversationId || event.conversationId === conversationId); }).map(row => row.id).join(':');
    },
    tools(actorId: string, currentId: string) {
      return memoryTools(projection(actorId), currentId).map(tool => {
        if (tool.name !== 'memory_search') return tool;
        const execute = tool.execute;
        return { ...tool, execute: async (...args: Parameters<typeof execute>) => {
          const result = await execute(...args);
          const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('');
          const items = JSON.parse(text) as Array<{ nodeId: string; score: number; messages: Array<{ id: string; offset: number; end: number }> }>;
          shown.set(JSON.stringify([actorId, currentId]), items.map(item => ({ nodeId: item.nodeId, score: item.score,
            shown: item.messages.map(message => ({ nodeId: item.nodeId, messageId: message.id, offset: message.offset, end: message.end })) })));
          return result;
        } };
      });
    },
    async search(actorId: string, query: string) { return projection(actorId).search(query); },
    async nodes(actorId: string): Promise<MemoryNode[]> { return memoryNodes(conversationEvents(await read(), actorId), memoryActor(actorId)); },
    async recordDeliveredTurn(input: { id: string; actorId: string; userText: string; assistantText: string; providerMessageId?: string; recallId?: string }) {
      // Only confirmed delivered ordinary text is learned. Repeated delivery callbacks are idempotent.
      if (!input.userText.trim() || !input.assistantText.trim()) return;
      const alreadyRecorded = !!db.prepare('SELECT id FROM delivered_turns WHERE id=?').get(input.id);
      const actor = memoryActor(input.actorId);
      const prior = alreadyRecorded ? conversationEvents(await read(), input.actorId).find(event => event.requestId === input.id && event.type === 'request_completed') : undefined;
      const now = prior?.at ?? new Date().toISOString();
      const events = [
        { type: 'message', requestId: input.id, role: 'user', text: input.userText, chatId: actor },
        { type: 'answer_generated', requestId: input.id, text: input.assistantText },
        { type: 'delivery_succeeded', requestId: input.id, providerMessageId: input.providerMessageId },
        { type: 'request_completed', requestId: input.id },
      ];
      if (!alreadyRecorded) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO delivered_turns VALUES (?)').run(input.id);
        for (const event of events) { const id = randomUUID(); db.prepare('INSERT INTO memory_records VALUES (?,?)').run(id, JSON.stringify({ ...event, conversationId: input.actorId, at: now, eventId: id })); }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      const recallKey = JSON.stringify([input.actorId, input.recallId ?? input.id]);
      const presented = shown.get(recallKey) ?? []; shown.delete(recallKey);
      const source = conversationEvents(await read(), input.actorId); const nodes = memoryNodes(source, actor);
      const dynamics = memoryDynamics(options.dynamics);
      const graph = memoryGraph(source, actor, text => embedding?.cached(text), dynamics);
      const activated = presented.flatMap(item => {
        const node = nodes.find(node => node.id === item.nodeId && node.id !== input.id);
        const references = item.shown.filter(reference => node?.messages.some(message => message.id === reference.messageId &&
          reference.offset >= 0 && reference.end > reference.offset && reference.end <= Array.from(message.text).length));
        const signal = learningSignal(item.score);
        return node && references.length && signal ? [{ ...item, shown: references, signal }] : [];
      }).slice(0, 8);
      await persistMemoryLearning(conversationLog(log, input.actorId), { type: 'memory_learned', requestId: input.id, userId: actor,
        algorithm: MEMORY_ALGORITHM, origin: 'online', snapshotId: `explicit:${input.id}`, settledAt: now, dynamics,
        deliveredSources: nodes.find(node => node.id === input.id)?.messages.filter(message => message.role === 'assistant').map(message => message.id) ?? [], activated },
      graph.initializations.filter(item => item.nodeId === input.id));
    },
    async forget(actorId: string, nodeId: string) {
      const events = conversationEvents(await read(), actorId);
      const originals = memoryNodes(events.filter(event => event.type !== 'memory_excluded'), memoryActor(actorId));
      if (!originals.some(node => node.id === nodeId)) throw new Error('记忆不存在或不属于当前用户');
      if (!events.some(event => event.type === 'memory_excluded' && event.nodeId === nodeId))
        await append({ type: 'memory_excluded', nodeId, userId: memoryActor(actorId), conversationId: actorId });
      await options.invalidateSessions(actorId, nodeId);
      await invalidateMemoryIndex(options.dataDir);
      embedding?.purge();
    },
    async close() { await embedding?.close(); db.close(); },
  };
}
