import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, rename, rm, writeFile, readdir, realpath, open } from 'node:fs/promises';
import { join, basename, resolve, relative, isAbsolute } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { SessionManager } from '@mariozechner/pi-coding-agent';
import type { Api, Model, Message } from '@mariozechner/pi-ai';
import { readLegacySource, type LegacySource } from '../runtime/legacy-source.js';
import { decodeRuntimeEvent, type RuntimeEventRow } from '../runtime/sqlite-runtime-log.js';
import type { StoredEvent, ToolArchive, ToolResult } from '../runtime/runtime-types.js';
import { conversationEvents, conversationOwnership } from '../runtime/conversation-log.js';
import { activeContextStart, historyScope } from '../runtime/history-scope.js';
import { encodeHistory } from '../agent/history-codec.js';
import { sourceDigest } from '../runtime/event-digest.js';
import { createCheckpointStore, type Checkpoint } from '../context/checkpoint.js';
import { PersonalStore } from './store.js';

async function exists(path: string) { try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function durableWrite(path: string, content: string) { const file = await open(path, 'w'); try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); } }

/** Read-only historical adapter. Never constructs the old writable runtime. */
export async function readHistoricalSource(directory: string): Promise<{ events: StoredEvent[]; sources: LegacySource[] }> {
  const file = join(directory, 'runtime-v2.sqlite');
  if (!await exists(file)) return readLegacySource(directory);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('BEGIN');
    const integrity = db.prepare('PRAGMA quick_check').get();
    if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error('历史事实库完整性检查失败');
    const rows = db.prepare('SELECT sequence,event_id,schema_version,session_id,payload FROM runtime_events ORDER BY sequence').all();
    const events = rows.map(row => decodeRuntimeEvent(row as RuntimeEventRow));
    return { events, sources: [{ file: 'runtime-v2.sqlite', count: events.length, digest: sourceDigest(events), disposition: events.length ? 'primary' : 'empty' }] };
  } finally { db.close(); }
}

interface MigrationManifest { version: 1; sourceDigest: string; backupDir: string; conversations: { id: string; session: string; path: string; messageCount: number }[] }

async function readonlyArchive(directory: string, archive: ToolArchive): Promise<ToolResult> {
  const path = archive.rawPath; if (!path) throw new Error('历史工具归档路径缺失');
  const root = await realpath(resolve(directory, 'tool-results')); const actual = await realpath(path);
  const inside = relative(root, actual); if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('历史工具归档路径不可信');
  const body = await readFile(actual);
  if (body.length !== archive.rawBytes || createHash('sha256').update(body).digest('hex') !== archive.rawSha256) throw new Error('历史工具归档缺失或校验失败');
  const value: ToolResult = JSON.parse(body.toString('utf8')); if (!Array.isArray(value.content)) throw new Error('历史工具归档格式错误'); return value;
}

async function backupSources(directory: string, destination: string, sources: LegacySource[]) {
  await mkdir(destination, { recursive: true });
  for (const source of sources) {
    const path = join(directory, source.file); const target = join(destination, source.file);
    if (await exists(target)) continue;
    if (source.file.endsWith('.sqlite')) { const db = new DatabaseSync(path, { readOnly: true }); try { await backup(db, target); } finally { db.close(); } }
    else await cp(path, target, { errorOnExist: true, force: false });
  }
  for (const name of ['tool-results', 'checkpoints', 'memory.json', 'akasha.json']) if (await exists(join(directory, name)) && !await exists(join(destination, name))) await cp(join(directory, name), join(destination, name), { recursive: true, errorOnExist: true, force: false });
}

/** One-time import uses historical codecs offline; all subsequent context belongs to Pi. */
export async function migratePersonalHistory(store: PersonalStore, model: Model<Api>): Promise<{ imported: number; sourceDigest: string; backupDir?: string }> {
  const snapshot = await readHistoricalSource(store.directory); const digest = sourceDigest(snapshot);
  if (!snapshot.events.length) return { imported: 0, sourceDigest: digest };
  const manifestPath = join(store.directory, 'personal-history-migration.json');
  if (await exists(manifestPath)) {
    const manifest: MigrationManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.version !== 1 || manifest.sourceDigest !== digest) throw new Error('历史源在切换后发生变化；请停止并核对 writer，不会重复导入');
    for (const conversation of manifest.conversations) if (!await exists(conversation.path)) {
      const directory = join(store.directory, 'personal-sessions', createHash('sha256').update(conversation.session).digest('hex'));
      const retiredPath = join(directory, 'retired.json');
      if (!await exists(retiredPath)) throw new Error('迁移 Session 丢失，需要从保留源恢复；不会静默重建');
      const retired = JSON.parse(await readFile(retiredPath, 'utf8'));
      if (!['reset', 'forget'].includes(retired.reason) || !Array.isArray(retired.sessionFiles) || !retired.sessionFiles.includes(basename(conversation.path))) throw new Error('Session 退役记录无效；不会重新导入已排除历史');
    }
    return { imported: 0, sourceDigest: digest, backupDir: manifest.backupDir };
  }
  const backupDir = join(store.directory, 'personal-history-backups', digest);
  await backupSources(store.directory, backupDir, snapshot.sources);
  if (sourceDigest((await readHistoricalSource(backupDir)).events) !== sourceDigest(snapshot.events)) throw new Error('历史备份校验失败；不会切换');
  const conversations = new Set(conversationOwnership(snapshot.events).values());
  for (const event of snapshot.events) if (typeof event.conversationId === 'string') conversations.add(event.conversationId); else if (typeof event.chatId === 'number') conversations.add(`telegram:private:${event.chatId}`);
  const manifest: MigrationManifest = { version: 1, sourceDigest: digest, backupDir, conversations: [] };
  for (const id of conversations) {
    const raw = conversationEvents(snapshot.events, id); const start = activeContextStart(raw); // Corrupt start fails closed, including #151.
    const latest = raw.findLast(event => event.type === 'message' && event.role === 'user');
    if (!latest) continue;
    const migrationId = `personal-history-import:${digest}:${id}`;
    const extended = [...raw, { type: 'message', role: 'user', text: '迁移边界（不作为用户委托）', requestId: migrationId, conversationId: id, at: latest.at }];
    const scope = historyScope(extended, migrationId);
    const encoded = await encodeHistory(scope, migrationId, model, false, {
      recoverArchive: archive => readonlyArchive(store.directory, archive), isArchiveRead: () => false,
    });
    let checkpoint: Checkpoint | undefined;
    if (start) {
      const boundary = `active-v1:${start.activeContextId}`;
      const durable = raw.filter(event => event.type === 'context_checkpoint_committed').flatMap(event => {
        const candidate = event.checkpoint as Checkpoint;
        return candidate?.version === 2 && candidate.boundary === boundary && sourceDigest(candidate) === event.sha256 && candidate.through > 0 && candidate.through <= scope.events.length && sourceDigest(scope.events.slice(0, candidate.through)) === candidate.sourceDigest && !scope.excluded.size ? [candidate] : [];
      });
      checkpoint = durable.sort((a, b) => b.through - a.through)[0];
      if (!checkpoint && !scope.excluded.size) checkpoint = await createCheckpointStore(store.directory, 'structured-text-v1', id).load(boundary, scope.events);
    }
    const messages: Message[] = [];
    if (checkpoint) messages.push({ role: 'user', content: `已接受的历史上下文摘要：\n${checkpoint.summary}`, timestamp: Date.parse(checkpoint.createdAt) });
    for (const unit of encoded.units) if (unit.requestId !== migrationId && (!checkpoint || unit.through > checkpoint.through || unit.protected || checkpoint.retainedInstructionThrough?.includes(unit.through))) messages.push(...unit.messages);
    const session = store.conversationSession(id); const targetDir = join(store.directory, 'personal-sessions', createHash('sha256').update(session).digest('hex'));
    // Stable staging identity makes retries safe even after rename before manifest commit.
    const marker = join(targetDir, 'historical-import.json');
    if (await exists(targetDir)) {
      if (!await exists(marker)) throw new Error('目标 Session 已有内容；不能覆盖未关联会话');
      const prior = JSON.parse(await readFile(marker, 'utf8'));
      if (prior.digest !== digest || prior.conversation !== id) throw new Error('Session 迁移身份不一致');
      manifest.conversations.push({ id, session, path: join(targetDir, prior.file), messageCount: prior.count }); continue;
    }
    const staging = targetDir + '.importing'; await mkdir(staging, { recursive: true });
    const leftovers = await readdir(staging); for (const name of leftovers) if (name.endsWith('.jsonl')) await rm(join(staging, name));
    const manager = SessionManager.create(store.directory, staging); manager.appendModelChange(model.provider, model.id);
    for (const message of messages) manager.appendMessage(message);
    // Pi flushes after an assistant entry; no user-only import should disappear.
    if (!messages.some(message => message.role === 'assistant')) manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '历史输入已保留。旧委托不会自动执行；后续工作以新的用户输入为准。' }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 });
    const file = manager.getSessionFile(); if (!file || !await exists(file)) throw new Error('Pi 历史 Session 未持久化');
    await durableWrite(join(staging, 'historical-import.json'), JSON.stringify({ digest, conversation: id, file: basename(file), count: messages.length }));
    await rename(staging, targetDir); manifest.conversations.push({ id, session, path: join(targetDir, basename(file)), messageCount: messages.length });
  }
  if (sourceDigest(await readHistoricalSource(store.directory)) !== digest) throw new Error('迁移期间历史源变化；不会提交切换');
  await durableWrite(manifestPath + '.tmp', JSON.stringify(manifest)); await rename(manifestPath + '.tmp', manifestPath);
  return { imported: manifest.conversations.length, sourceDigest: digest, backupDir };
}
