import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
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
import { boundedBackground, recallIdentity, type RecallRecord, type MemorySpan } from './memory-context.js';
import type { PersonalInput, SessionReceipt, ContextReference, ContextPacket } from './types.js';
import { memoryBudget, type MemoryBudget } from '../application/memory-context.js';

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
  const databasePath = join(options.dataDir, 'personal-memory.sqlite'); const existing = existsSync(databasePath);
  const db = new DatabaseSync(databasePath);
  try {
  const hasSchema = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_schema'").get();
  const version = hasSchema ? Number(db.prepare('SELECT version FROM memory_schema WHERE id=1').get()?.version ?? 0) : 0;
  if (version > 1) throw new Error('记忆数据库版本高于当前运行时，不会降级');
  if (!version) {
    if (existing) {
      const directory = join(options.dataDir, 'memory-schema-backups'); mkdirSync(directory, { recursive: true });
      const backupPath = join(directory, `v0-before-v1-${randomUUID()}.sqlite`); db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
      const file = openSync(backupPath, 'r+'); try { fsyncSync(file); } finally { closeSync(file); }
      const backup = new DatabaseSync(backupPath, { readOnly: true }); try { if (Object.values(backup.prepare('PRAGMA quick_check').get()!)[0] !== 'ok') throw new Error('记忆备份校验失败'); } finally { backup.close(); }
    }
    db.exec('BEGIN IMMEDIATE; CREATE TABLE memory_schema(id INTEGER PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO memory_schema VALUES(1,1); CREATE TABLE recall_records(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE presented_sources(id TEXT PRIMARY KEY,body TEXT NOT NULL); COMMIT');
  }
  db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS memory_records (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS delivered_turns (id TEXT PRIMARY KEY)');
  } catch (error) { db.close(); throw error; }
  let embedding: ReturnType<typeof createEmbeddingClient> | undefined;
  try { embedding = options.embedding ? createEmbeddingClient(options.dataDir, { maxBackgroundAttempts: 3, ...options.embedding }) : undefined; }
  catch (error) { db.close(); throw error; }
  const getRecall = (id: string): RecallRecord | undefined => { const row = db.prepare('SELECT body FROM recall_records WHERE id=?').get(id); return row ? JSON.parse(String(row.body)) : undefined; };
  const putRecall = (record: RecallRecord) => { db.prepare('INSERT INTO recall_records VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(record.id, JSON.stringify(record)); };
  const exclusionVersion = (conversationId?: string) => (db.prepare('SELECT id,payload FROM memory_records ORDER BY rowid').all() as Array<{ id: string; payload: string }>).filter(row => { const event = JSON.parse(row.payload) as StoredEvent; return event.type === 'memory_excluded' && (!conversationId || event.conversationId === conversationId); }).map(row => row.id).join(':');
  type Presented = Array<{ nodeId: string; score: number; shown: Array<{ nodeId: string; messageId: string; offset: number; end: number }> }>;
  const presented = (key: string): Presented => { const row = db.prepare('SELECT body FROM presented_sources WHERE id=?').get(key); return row ? JSON.parse(String(row.body)) : []; };
  const addPresented = (key: string, items: Presented) => {
    const merged = presented(key); for (const item of items) { let node = merged.find(value => value.nodeId === item.nodeId); if (!node) { node = { ...item, shown: [] }; merged.push(node); } node.score = Math.max(node.score, item.score); for (const span of item.shown) if (!node.shown.some(value => value.messageId === span.messageId && value.offset === span.offset && value.end === span.end)) node.shown.push(span); }
    db.prepare('INSERT INTO presented_sources VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(merged));
  };
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
    exclusionVersion, getRecall,
    recalls(conversationId: string) { return (db.prepare('SELECT body FROM recall_records ORDER BY rowid').all() as Array<{ body: string }>).map(row => JSON.parse(row.body) as RecallRecord).filter(record => record.conversationId === conversationId); },
    async selectBackground(conversationId: string, references: ContextReference[], agreementIds: string[] = []): Promise<ContextPacket> {
      const nodes = await projection(conversationId).nodes(); const selected: Array<{ node: MemoryNode; score: number }> = [];
      for (const ref of references.slice(0, 20)) {
        const node = nodes.find(node => node.id === ref.nodeId); const message = node?.messages.find(message => message.id === ref.messageId);
        if (!node || !message) throw new Error('选定背景来源不存在、已排除或不属于当前会话');
        const points = Array.from(message.text); const offset = ref.offset ?? 0; const limit = ref.limit ?? 1000;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > points.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('选定背景读取范围无效');
        selected.push({ node: { ...node, messages: [{ ...message, text: points.slice(offset, offset + limit).join('') }] }, score: 1 });
      }
      const bounded = boundedBackground(selected, 40960); const spans = bounded.spans.map(span => { const ref = references.find(ref => ref.nodeId === span.nodeId && ref.messageId === span.messageId)!; return { ...span, offset: ref.offset ?? 0, end: (ref.offset ?? 0) + span.end }; });
      return { version: 1, content: `本体选择的相关原文（执行材料；不是新用户输入）：${JSON.stringify(spans)}`, spans, agreementIds: [...new Set(agreementIds)].slice(0, 20), source: 'parent_selected', at: Date.now() };
    },
    async recall(input: PersonalInput, model: string, inputBudget: number, budget?: MemoryBudget): Promise<RecallRecord | undefined> {
      if (input.origin === 'plan') return;
      const id = recallIdentity(input); let record = getRecall(id); const currentVersion = exclusionVersion(input.conversationId);
      if (record) {
        if (record.exclusionVersion !== currentVersion) { record.state = 'excluded'; record.content = ''; record.spans = []; putRecall(record); }
        else if (record.state === 'started') { record.state = 'unavailable'; record.error = '上次召回检索状态未知，未重复外部检索'; putRecall(record); }
        else if (record.state === 'ready' && memoryBudget(inputBudget, budget) < record.budget) {
          const nodes = await projection(input.conversationId).nodes();
          const candidates = [...new Set(record.references.map(ref => ref.nodeId))].flatMap(id => { const node = nodes.find(node => node.id === id); return node ? [{ node, score: record!.references.find(ref => ref.nodeId === id)?.score ?? 0 }] : []; });
          const selected = boundedBackground(candidates, inputBudget, budget); Object.assign(record, selected, { model, injection: undefined }); putRecall(record);
        }
        return record;
      }
      record = { version: 1, id, conversationId: input.conversationId, actorId: input.actorId, inputId: input.inputId, query: input.text, model, budget: 0, exclusionVersion: currentVersion, state: 'started', spans: [], references: [], content: '' }; putRecall(record);
      try {
        const candidates = await projection(input.conversationId).search(input.text, 20, input.inputId);
        const selected = boundedBackground(candidates, inputBudget, budget);
        if (currentVersion !== exclusionVersion(input.conversationId)) { record.state = 'excluded'; }
        else { Object.assign(record, selected); record.state = 'ready'; }
      } catch (error) { record.state = 'unavailable'; record.error = String(error); }
      putRecall(record); return record;
    },
    markRecallInjection(id: string, receipt: SessionReceipt) { const record = getRecall(id); if (!record || record.state !== 'ready') throw new Error('召回记录不可注入'); record.injection = receipt; putRecall(record); },
    presentRecall(id: string) { const record = getRecall(id); if (record?.state === 'ready' && record.exclusionVersion === exclusionVersion(record.conversationId)) addPresented(JSON.stringify([record.conversationId, id]), record.spans.map(span => ({ nodeId: span.nodeId, score: span.score, shown: [{ nodeId: span.nodeId, messageId: span.messageId, offset: span.offset, end: span.end }] }))); },
    tools(actorId: string, currentId: string) {
      return memoryTools(projection(actorId), currentId).map(tool => {
        const execute = tool.execute;
        return { ...tool, execute: async (...args: Parameters<typeof execute>) => {
          const result = await execute(...args);
          const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('');
          if (tool.name === 'memory_search') {
            const items = JSON.parse(text) as Array<{ nodeId: string; score: number; messages: Array<{ id: string; offset: number; end: number }> }>;
            addPresented(JSON.stringify([actorId, currentId]), items.map(item => ({ nodeId: item.nodeId, score: item.score, shown: item.messages.map(message => ({ nodeId: item.nodeId, messageId: message.id, offset: message.offset, end: message.end })) })));
          } else { const item = JSON.parse(text) as { nodeId: string; messageId: string; offset: number; end: number }; addPresented(JSON.stringify([actorId, currentId]), [{ nodeId: item.nodeId, score: 1, shown: [item] }]); }
          return result;
        } };
      });
    },
    async search(actorId: string, query: string) { return projection(actorId).search(query); },
    async nodes(actorId: string): Promise<MemoryNode[]> { return memoryNodes(conversationEvents(await read(), actorId), memoryActor(actorId)); },
    async deliveryLearning(id: string) { return (await read()).filter(event => event.type === 'memory_learned' && event.requestId === id); },
    async recordDeliveredTurn(input: { id: string; actorId: string; userText: string; assistantText: string; providerMessageId?: string; recallId?: string; originInputId?: string; inputAt?: number }) {
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
        for (const event of events) { const id = randomUUID(); db.prepare('INSERT INTO memory_records VALUES (?,?)').run(id, JSON.stringify({ ...event, conversationId: input.actorId, at: event.type === 'message' ? (input.inputAt !== undefined && Number.isFinite(input.inputAt) ? new Date(input.inputAt).toISOString() : '') : now, ...(event.type === 'message' ? { originInputId: input.originInputId, timeKnown: input.inputAt !== undefined && Number.isFinite(input.inputAt) } : {}), eventId: id })); }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      const recallKey = JSON.stringify([input.actorId, input.recallId ?? input.id]);
      const shown = presented(recallKey);
      const source = conversationEvents(await read(), input.actorId); const nodes = memoryNodes(source, actor);
      const dynamics = memoryDynamics(options.dynamics);
      const graph = memoryGraph(source, actor, text => embedding?.cached(text), dynamics);
      const activated = shown.flatMap(item => {
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
