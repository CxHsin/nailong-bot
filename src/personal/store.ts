import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Task, Attempt, Delivery, PersonalResponse, ActionRecord, PersonalInput } from './types.js';

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
    try {
      this.db = new DatabaseSync(join(directory, 'personal.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, task TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inputs(id TEXT PRIMARY KEY, response TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
        CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, session TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
    } catch (error) { this.owner.close(); throw error; }
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
  listTasks(conversation?: string) { return this.list<Task>('tasks').filter(task => !conversation || task.conversationId === conversation); }
  putTask(task: Task) { this.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(task.id, task.conversationId, JSON.stringify(task)); }
  getAttempt(id: string) { return this.read<Attempt>('attempts', id); }
  listAttempts(taskId?: string) { return this.list<Attempt>('attempts').filter(attempt => !taskId || attempt.taskId === taskId); }
  putAttempt(attempt: Attempt) { this.db.prepare('INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(attempt.id, attempt.taskId, JSON.stringify(attempt)); }
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
