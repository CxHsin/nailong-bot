import { closeSync, existsSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Task, Attempt, Delivery, PersonalResponse, ActionRecord, PersonalInput, WorkEvent, SessionReceipt, ActionDispatch, WorkBudget, WorkingAgreement } from './types.js';

/** Business records are authoritative; SDK sessions contain model exchanges only. */
export class PersonalStore {
  private readonly db: DatabaseSync;
  private readonly owner: DatabaseSync;
  private depth = 0;
  private closed = false;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.owner = new DatabaseSync(join(directory, 'host-owner.sqlite'));
    try { this.owner.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
    catch (error) { this.owner.close(); throw new Error('该数据目录已被另一个 Host 占用', { cause: error }); }
    let database: DatabaseSync | undefined;
    try {
      const databasePath = join(directory, 'personal.sqlite');
      const existingDatabase = existsSync(databasePath);
      database = new DatabaseSync(databasePath); this.db = database;
      this.upgradeBusinessSchema(existingDatabase);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, task TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inputs(id TEXT PRIMARY KEY, response TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
        CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, session TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS work_events(id TEXT PRIMARY KEY, task TEXT NOT NULL, attempt TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(task,attempt,kind));
        CREATE TABLE IF NOT EXISTS action_dispatches(id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
    } catch (error) { database?.close(); this.owner.close(); throw error; }
  }
  /** Schema upgrades never reuse or change the historical import manifest. */
  private upgradeBusinessSchema(existingDatabase: boolean) {
    const hasSchema = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='personal_schema'").get();
    const version = hasSchema ? Number(this.db.prepare('SELECT version FROM personal_schema WHERE id=1').get()?.version ?? 0) : 0;
    if (version > 3) throw new Error('业务数据库版本高于当前 Host；不会降级或启动');
    if (version === 3) return;
    let backupPath: string | undefined;
    if (existingDatabase) {
      const backupDirectory = join(this.directory, 'personal-schema-backups'); mkdirSync(backupDirectory, { recursive: true });
      backupPath = join(backupDirectory, `v${version}-before-v3-${randomUUID()}.sqlite`);
      // VACUUM INTO includes committed WAL pages in a consistent SQLite snapshot.
      this.db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
      const backupFile = openSync(backupPath, 'r+'); try { fsyncSync(backupFile); } finally { closeSync(backupFile); }
      const backup = new DatabaseSync(backupPath, { readOnly: true });
      try { if (Object.values(backup.prepare('PRAGMA quick_check').get()!)[0] !== 'ok') throw new Error('业务数据库备份校验失败'); }
      finally { backup.close(); }
    }
    this.transaction(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS personal_schema(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, backup_path TEXT); CREATE TABLE IF NOT EXISTS work_budgets(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS working_agreements(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
      const hasTasks = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
      if (hasTasks) for (const task of this.list<Task>('tasks')) {
        task.workKind ??= 'root'; task.rootTaskId ??= task.id;
        this.putTask(task);
      }
      this.db.prepare('INSERT INTO personal_schema VALUES(1,3,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,backup_path=excluded.backup_path').run(backupPath ?? null);
    });
  }
  businessSchema(): { version: number; backupPath?: string } {
    const row = this.db.prepare('SELECT version,backup_path FROM personal_schema WHERE id=1').get()!;
    return { version: Number(row.version), ...(row.backup_path ? { backupPath: String(row.backup_path) } : {}) };
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  private read<T>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row.body)) as T : undefined;
  }
  private list<T>(table: string): T[] { return this.db.prepare(`SELECT body FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.body)) as T); }
  getTask(id: string) { return this.read<Task>('tasks', id); }
  listAgreements() { return this.list<WorkingAgreement>('working_agreements'); }
  putAgreement(agreement: WorkingAgreement) { this.db.prepare('INSERT INTO working_agreements VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(agreement.id, JSON.stringify(agreement)); }
  getBudget(id: string) { return this.read<WorkBudget>('work_budgets', id); }
  putBudget(budget: WorkBudget) { this.db.prepare('INSERT INTO work_budgets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(budget.id, JSON.stringify(budget)); }
  listTasks(conversation?: string) { return this.list<Task>('tasks').filter(task => !conversation || task.conversationId === conversation); }
  putTask(task: Task) { task.workKind ??= task.parentTaskId ? 'delegation' : 'root'; task.rootTaskId ??= task.parentTaskId ? this.getTask(task.parentTaskId)?.rootTaskId ?? task.parentTaskId : task.id; this.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(task.id, task.conversationId, JSON.stringify(task)); }
  getAttempt(id: string) { return this.read<Attempt>('attempts', id); }
  listAttempts(taskId?: string) { return this.list<Attempt>('attempts').filter(attempt => !taskId || attempt.taskId === taskId); }
  putAttempt(attempt: Attempt) { this.db.prepare('INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(attempt.id, attempt.taskId, JSON.stringify(attempt)); }
  getWorkEvent(id: string) { return this.read<WorkEvent>('work_events', id); }
  listWorkEvents(conversation?: string) { return this.list<WorkEvent>('work_events').filter(event => !conversation || event.conversationId === conversation); }
  enqueueWorkEvent(event: WorkEvent): WorkEvent {
    const existing = this.getWorkEvent(event.id); if (existing) return existing;
    this.db.prepare('INSERT INTO work_events VALUES(?,?,?,?,?)').run(event.id, event.taskId, event.attemptId, event.kind, JSON.stringify(event)); return event;
  }
  /** Latest cancellation/requirements win over the executor's starting snapshot. */
  settleDelegationResult(task: Task, attempt: Attempt): WorkEvent {
    return this.transaction(() => {
      const id = `delegation_result:${task.id}:${attempt.id}`;
      const previous = this.getWorkEvent(id); if (previous) return previous;
      const current = this.getTask(task.id);
      const parent = current?.parentTaskId ? this.getTask(current.parentTaskId) : undefined;
      if (!current || !parent || current.workKind !== 'delegation' || attempt.taskId !== current.id || !task.result) throw new Error('委派成果身份或父工作无效');
      if (current.conversationId !== parent.conversationId || current.actorId !== parent.actorId) throw new Error('委派不能跨会话或用户结算');
      const cancelled = current.cancelRequested || parent.cancelRequested || current.status === 'cancelled' || parent.status === 'cancelled';
      const result = { ...task.result };
      if (result.producedRevision !== current.revision) result.verified = false;
      current.result = result; current.updatedAt = task.updatedAt;
      if (!cancelled) { current.status = ['waiting', 'stopping', 'queued'].includes(task.status) ? task.status : result.verified && !result.partial ? task.status : 'partial'; current.resourceHeld = task.resourceHeld; }
      const latestAttempt = this.getAttempt(attempt.id);
      if (latestAttempt && latestAttempt.taskId !== current.id) throw new Error('Attempt 身份冲突');
      const settledAttempt = { ...attempt, ...latestAttempt, status: current.status, finishedAt: attempt.finishedAt };
      const event: WorkEvent = { id, kind: 'delegation_result', conversationId: current.conversationId, taskId: current.id,
        parentTaskId: parent.id, rootTaskId: current.rootTaskId ?? parent.rootTaskId ?? parent.id, attemptId: attempt.id,
        revision: parent.revision, result, createdAt: task.updatedAt, state: cancelled || parent.contextExcluded || current.contextExcluded ? 'blocked' : 'pending' };
      this.putTask(current); this.putAttempt(settledAttempt);
      this.db.prepare('INSERT INTO work_events VALUES(?,?,?,?,?)').run(event.id, current.id, attempt.id, event.kind, JSON.stringify(event));
      return event;
    });
  }
  private putWorkEvent(event: WorkEvent) { this.db.prepare('UPDATE work_events SET body=? WHERE id=?').run(JSON.stringify(event), event.id); }
  claimWorkEvent(id: string): WorkEvent | undefined {
    return this.transaction(() => {
      const event = this.getWorkEvent(id); if (!event || event.state !== 'pending') return undefined;
      const child = this.getTask(event.taskId); const parent = this.getTask(event.parentTaskId); const root = this.getTask(event.rootTaskId);
      if (!child || !parent || !root || [child, parent, root].some(task => task.cancelRequested || task.contextExcluded || task.status === 'cancelled')) {
        event.state = 'blocked'; event.error = '工作已取消或背景已排除'; this.putWorkEvent(event); return undefined;
      }
      event.state = 'processing'; this.putWorkEvent(event); return event;
    });
  }
  /** A recovery decision can pause or release an event; it cannot erase receipts. */
  transitionWorkEvent(id: string, expected: WorkEvent['state'], state: WorkEvent['state'], error?: string): boolean {
    if (state === 'consumed') throw new Error('消费必须保存 Session 完成回执');
    return this.transaction(() => {
      const event = this.getWorkEvent(id); if (!event || event.state !== expected || event.state === 'consumed') return false;
      event.state = state; event.error = error; this.putWorkEvent(event); return true;
    });
  }
  recordWorkEventInjection(id: string, receipt: SessionReceipt) {
    return this.transaction(() => {
      const event = this.getWorkEvent(id); if (!event) throw new Error('工作事件不存在');
      if (event.injection) { if (JSON.stringify(event.injection) !== JSON.stringify(receipt)) throw new Error('Session 注入回执冲突'); return event; }
      if (event.state !== 'processing') throw new Error('只有处理中事件可以记录 Session 注入');
      event.injection = receipt; this.putWorkEvent(event); return event;
    });
  }
  completeWorkEvent(id: string, receipt: SessionReceipt) {
    return this.transaction(() => {
      const event = this.getWorkEvent(id); if (!event?.injection) throw new Error('缺少 Session 注入回执');
      if (event.injection.sessionId !== receipt.sessionId) throw new Error('Session 完成回执身份不匹配');
      if (event.completion) { if (JSON.stringify(event.completion) !== JSON.stringify(receipt)) throw new Error('Session 完成回执冲突'); return event; }
      if (event.state !== 'processing') throw new Error('只有处理中事件可以消费');
      if (this.listActionDispatches(id).some(action => ['dispatching', 'unknown'].includes(action.status))) throw new Error('动作派发状态尚未核实');
      const child = this.getTask(event.taskId); const parent = this.getTask(event.parentTaskId); const root = this.getTask(event.rootTaskId);
      if (!child || !parent || !root || [child, parent, root].some(task => task.cancelRequested || task.contextExcluded || task.status === 'cancelled')) { event.state = 'blocked'; event.error = '完成期间工作取消或背景排除'; }
      else { event.completion = receipt; event.state = 'consumed'; }
      this.putWorkEvent(event); return event;
    });
  }
  getActionDispatch(id: string) { return this.read<ActionDispatch>('action_dispatches', id); }
  listActionDispatches(eventId?: string) { return this.list<ActionDispatch>('action_dispatches').filter(action => !eventId || action.eventId === eventId); }
  /** Persist before dispatch; an existing identity is evidence to reconcile, never permission to repeat. */
  reserveActionDispatch(record: ActionDispatch): { record: ActionDispatch; created: boolean } {
    return this.transaction(() => {
      const existing = this.getActionDispatch(record.id);
      if (existing) {
        if (existing.taskId !== record.taskId || existing.eventId !== record.eventId || existing.attemptId !== record.attemptId || existing.revision !== record.revision || JSON.stringify(existing.action) !== JSON.stringify(record.action)) throw new Error('动作派发身份冲突');
        return { record: existing, created: false };
      }
      if (record.status !== 'dispatching') throw new Error('动作派发必须从 dispatching 开始');
      const task = this.getTask(record.taskId); if (!task || task.cancelRequested || task.contextExcluded || task.status === 'cancelled' || task.revision !== record.revision) throw new Error('动作所属工作已失效或要求已变更');
      if (record.eventId) { const event = this.getWorkEvent(record.eventId); if (!event || event.state !== 'processing' || !event.injection || event.parentTaskId !== task.id) throw new Error('动作没有有效的事件注入身份'); }
      this.db.prepare('INSERT INTO action_dispatches VALUES(?,?)').run(record.id, JSON.stringify(record));
      return { record, created: true };
    });
  }
  finishActionDispatch(id: string, status: Exclude<ActionDispatch['status'], 'dispatching'>, evidence?: string) {
    return this.transaction(() => {
      const record = this.getActionDispatch(id); if (!record) throw new Error('动作派发不存在');
      if (['succeeded', 'failed'].includes(record.status) && record.status !== status) throw new Error('已确认动作结果不能被覆盖');
      record.status = status; record.evidence = evidence; record.finishedAt = Date.now();
      this.db.prepare('UPDATE action_dispatches SET body=? WHERE id=?').run(JSON.stringify(record), id); return record;
    });
  }
  getDelivery(id: string) { return this.read<Delivery>('deliveries', id); }
  listDeliveries(conversation?: string) { return this.list<Delivery>('deliveries').filter(delivery => !conversation || delivery.conversationId === conversation); }
  putDelivery(delivery: Delivery) { this.db.prepare('INSERT INTO deliveries VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(delivery.id, delivery.conversationId, JSON.stringify(delivery)); }
  getPlan<T>(id: string) { return this.read<T>('plans', id); }
  listPlans<T>() { return this.list<T>('plans'); }
  putPlan<T extends { id: string }>(plan: T) { this.db.prepare('INSERT INTO plans VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(plan.id, JSON.stringify(plan)); }
  getAction(id: string) { return this.read<ActionRecord>('actions', id); }
  listActions(taskId?: string) { return this.list<ActionRecord>('actions').filter(a => !taskId || a.taskId === taskId); }
  putAction(action: ActionRecord) { this.db.prepare('INSERT INTO actions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(action.id, JSON.stringify(action)); }
  getInput(key: string): PersonalResponse | undefined {
    const row = this.db.prepare('SELECT response FROM inputs WHERE id=?').get(key);
    return row ? JSON.parse(String(row.response)) as PersonalResponse : undefined;
  }
  putInput(key: string, response: PersonalResponse) { this.db.prepare('INSERT INTO inputs VALUES(?,?)').run(key, JSON.stringify(response)); }
  acceptInput(key: string, input: PersonalInput): PersonalInput { this.db.prepare('INSERT INTO inbox(id,body) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(key, JSON.stringify(input)); return JSON.parse(String(this.db.prepare('SELECT body FROM inbox WHERE id=?').get(key)!.body)) as PersonalInput; }
  inputAttempts(key: string) { return Number(this.db.prepare('SELECT attempts FROM inbox WHERE id=?').get(key)?.attempts ?? 0); }
  beginInput(key: string) { this.db.prepare('UPDATE inbox SET attempts=attempts+1,error=NULL WHERE id=?').run(key); }
  inputFailure(key: string, error: string) { this.db.prepare('UPDATE inbox SET error=? WHERE id=?').run(error, key); }
  pendingInputs(): PersonalInput[] { return this.db.prepare('SELECT body FROM inbox WHERE id NOT IN (SELECT id FROM inputs) ORDER BY rowid').all().map(row => JSON.parse(String(row.body)) as PersonalInput); }
  conversationSession(id: string) {
    const existing = this.db.prepare('SELECT session FROM conversations WHERE id=?').get(id);
    if (existing) return String(existing.session);
    const session = randomUUID(); this.db.prepare('INSERT INTO conversations VALUES(?,?)').run(id, session); return session;
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); this.owner.close(); } }
}
