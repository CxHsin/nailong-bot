import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { ReplyMessage } from "../application/app-types.js";
import type { TelegramMaterial } from "./persona.js";

export type QueueInput = {
  conversationId: string;
  inputId: string;
  text: string;
  images?: ImageContent[];
  source?: string;
  priority?: number;
  kind?: "message" | "command" | "internal";
  userText?: string;
  replyToMessageId?: string;
  replyToMessage?: ReplyMessage;
  replyToInputId?: string;
  receivedAt?: number;
  runtimeMaterials?: string[];
  telegram?: TelegramMaterial;
  targetId?: string;
  actionText?: string;
};
export type PersistedInput = QueueInput & {
  eventId: string;
  sequence: number;
  source: string;
  priority: number;
  kind: "message" | "command" | "internal";
  targetId?: string;
  actionText?: string;
  supplements?: Array<PersistedInput & { actionId: string }>;
};
export type RoutingAction = {
  id: string;
  kind: "request" | "supplement" | "cancel" | "clarify";
  text: string;
  target?: string;
  candidates?: string[];
  state?: "pending" | "submitted" | "handled" | "unknown";
  submissionId?: string;
  reason?: string;
  delivery?: "helper";
};
export type RoutingDecision = { actions: Array<Omit<RoutingAction, "id"> & { id?: string }>; reason?: string; snapshot?: unknown };
export type RoutingRecord = { eventId: string; input: PersistedInput; decision?: { actions: RoutingAction[]; reason?: string; snapshot?: unknown }; state: "pending" | "decided" | "handled" };
export type QueueWork = {
  id: string; conversationId: string; inputId: string; eventId: string; summary: string;
  status: "queued" | "running" | "completed" | "cancelled" | "paused" | "needs_confirmation";
  batchId?: string; submissionId?: string; input: PersistedInput;
};
type InputRow = { id: string; sequence: number; payload: string };
type WorkRow = { id: string; event_id: string; sequence: number; ordinal: number; conversation: string; payload: string; status: QueueWork["status"]; batch_id: string | null; submission: string | null };
export type BatchStatus = "running" | "preempted" | "paused" | "needs_confirmation" | "completed";
export type ProcessingBatch = {
  id: string;
  requestKey: string;
  conversationId: string;
  events: PersistedInput[];
  submissionId?: string;
  previousSubmissionId?: string;
  resumed: boolean;
  reconcile: boolean;
  retryEpoch?: number;
};
export type StoredBatch = ProcessingBatch & { status: BatchStatus; reason?: string };
type BatchRow = { id: string; conversation: string; request_key: string; status: BatchStatus; submission: string | null; previous_submission: string | null; priority: number; attempt: number; reconcile: number; retry_epoch?: number; reason?: string|null };

export function inputPriority(input: QueueInput) {
  const source = input.source ?? (input.conversationId.startsWith("telegram:") ? "telegram" : "cli");
  return input.priority ?? (["telegram", "cli", "user", "direct"].includes(source) ? 100 : 0);
}

/** Input and fixed batch membership are committed before the channel acknowledges receipt. */
export class PersistentAssistantQueue {
  private readonly db: DatabaseSync;
  private readonly snapshots = new Map<string, number>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS inputs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        conversation TEXT NOT NULL, source TEXT NOT NULL, input_id TEXT NOT NULL,
        priority INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        batch_id TEXT, UNIQUE(conversation, source, input_id));
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY, conversation TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE,
        priority INTEGER NOT NULL, status TEXT NOT NULL, submission TEXT, reason TEXT,
        previous_submission TEXT, attempt INTEGER NOT NULL DEFAULT 0, reconcile INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS internal_results (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        conversation TEXT NOT NULL, source TEXT NOT NULL, input_id TEXT NOT NULL,
        priority INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        batch_id TEXT, UNIQUE(conversation, source, input_id));
      CREATE INDEX IF NOT EXISTS waiting_inputs ON inputs(conversation, batch_id, sequence);`);
    const columns = this.db.prepare("PRAGMA table_info(batches)").all() as Array<{name: string}>;
    if (!columns.some((column) => column.name === "retry_epoch")) this.db.exec("ALTER TABLE batches ADD COLUMN retry_epoch INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`CREATE TABLE IF NOT EXISTS routing (
      event_id TEXT PRIMARY KEY, state TEXT NOT NULL, decision TEXT);
      CREATE TABLE IF NOT EXISTS works (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, conversation TEXT NOT NULL,
        sequence INTEGER NOT NULL, ordinal INTEGER NOT NULL, priority INTEGER NOT NULL,
        source TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL, batch_id TEXT, submission TEXT);
      CREATE INDEX IF NOT EXISTS waiting_works ON works(conversation,status,sequence,ordinal);
      INSERT OR IGNORE INTO works(id,event_id,conversation,sequence,ordinal,priority,source,kind,payload,status,batch_id,submission)
        SELECT i.id,i.id,i.conversation,i.sequence,0,i.priority,i.source,i.kind,i.payload,
          CASE WHEN i.batch_id IS NULL THEN 'queued' WHEN b.status='preempted' THEN 'running' ELSE COALESCE(b.status,'queued') END,
          i.batch_id,b.submission FROM inputs i LEFT JOIN batches b ON b.id=i.batch_id
          WHERE i.kind!='query' AND NOT EXISTS(SELECT 1 FROM routing r WHERE r.event_id=i.id);`);
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  receive(input: QueueInput, routingPending = false) { return this.store(input, "inputs", routingPending); }
  receiveQuery(input: QueueInput) { return this.store(input, "inputs", false, true); }
  receiveInternal(input: QueueInput) { return this.store({ ...input, source: input.source ?? "herdr", kind: "internal", priority: input.priority ?? 0 }, "internal_results"); }
  private store(input: QueueInput, table: "inputs" | "internal_results", routingPending = false, query = false) {
    const source = input.source ?? (input.conversationId.startsWith("telegram:") ? "telegram" : "cli");
    const priority = inputPriority(input);
    if (!Number.isFinite(priority)) throw new Error("Input priority must be finite");
    const kind = input.kind ?? (input.text.trimStart().startsWith("/") ? "command" : "message");
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT id FROM ${table} WHERE conversation=? AND source=? AND input_id=?`)
        .get(input.conversationId, source, input.inputId) as { id: string } | undefined;
      if (existing) return { accepted: false, duplicate: true, eventId: existing.id };
      const eventId = randomUUID();
      this.db.prepare(`INSERT INTO ${table}(id,conversation,source,input_id,priority,kind,payload) VALUES(?,?,?,?,?,?,?)`)
        // Query receipts must also stay out of the startup work backfill.
        .run(eventId, input.conversationId, source, input.inputId, priority, query ? "query" : kind, JSON.stringify({ ...input, receivedAt: input.receivedAt ?? Date.now(), source, priority, kind }));
      if (table === "inputs" && !query) {
        if (routingPending) this.db.prepare("INSERT INTO routing(event_id,state) VALUES(?,'pending')").run(eventId);
        else this.addWork(this.getInput(eventId)!, eventId, 0);
        // Persist the interruption decision with receipt, before the cooperative abort can run.
        this.db.prepare("UPDATE batches SET status='preempted' WHERE conversation=? AND status='running' AND priority<?")
          .run(input.conversationId, priority);
      }
      return { accepted: true, duplicate: false, eventId };
    });
  }
  private getInput(eventId: string): PersistedInput | undefined {
    const row = this.db.prepare("SELECT id,sequence,payload FROM inputs WHERE id=?").get(eventId) as InputRow | undefined;
    return row ? { ...JSON.parse(row.payload), eventId: row.id, sequence: row.sequence } : undefined;
  }
  private addWork(input: PersistedInput, id: string, ordinal: number, actionText?: string) {
    const payload = { ...input, targetId: id, ...(actionText === undefined ? {} : { actionText }) };
    this.db.prepare("INSERT OR IGNORE INTO works(id,event_id,conversation,sequence,ordinal,priority,source,kind,payload,status) VALUES(?,?,?,?,?,?,?,?,?,'queued')")
      .run(id,input.eventId,input.conversationId,input.sequence,ordinal,input.priority,input.source,input.kind,JSON.stringify(payload));
  }
  routingPending(conversationId?: string): RoutingRecord[] {
    const rows = this.db.prepare(`SELECT r.event_id,r.state,r.decision FROM routing r JOIN inputs i ON i.id=r.event_id WHERE r.state!='handled' ${conversationId ? "AND i.conversation=?" : ""} ORDER BY i.sequence`)
      .all(...(conversationId ? [conversationId] : [])) as Array<{event_id:string;state:RoutingRecord["state"];decision:string|null}>;
    return rows.map((row)=>({eventId:row.event_id,input:this.getInput(row.event_id)!,state:row.state,...(row.decision ? {decision:JSON.parse(row.decision)} : {})}));
  }
  routingRecord(eventId: string): RoutingRecord | undefined {
    const row = this.db.prepare("SELECT state,decision FROM routing WHERE event_id=?").get(eventId) as {state:RoutingRecord["state"];decision:string|null}|undefined;
    const input = this.getInput(eventId);
    return row && input ? {eventId,input,state:row.state,...(row.decision ? {decision:JSON.parse(row.decision)} : {})} : undefined;
  }
  pendingHelperRoutes(): RoutingRecord[] {
    return (this.db.prepare("SELECT event_id,state,decision FROM routing WHERE decision IS NOT NULL ORDER BY rowid").all() as Array<{event_id:string;state:RoutingRecord["state"];decision:string}>)
      .map(row => ({eventId:row.event_id,input:this.getInput(row.event_id)!,state:row.state,decision:JSON.parse(row.decision) as NonNullable<RoutingRecord["decision"]>}))
      .filter(route => route.decision.actions.some(action => action.delivery === "helper" && action.state === "submitted"));
  }
  decideRoute(eventId: string, decision: RoutingDecision): RoutingRecord {
    return this.transaction(()=>{
      const input = this.getInput(eventId);
      if (!input) throw new Error("Unknown routing input");
      const row = this.db.prepare("SELECT state,decision FROM routing WHERE event_id=?").get(eventId) as {state:RoutingRecord["state"];decision:string|null}|undefined;
      if (!row) throw new Error("Input is not awaiting routing");
      if (row.decision) return {eventId,input,state:row.state,decision:JSON.parse(row.decision)};
      const stored = {...decision,actions:decision.actions.map((action,index)=>({...action,id:`${eventId}:${index}`,state:"pending" as const}))};
      this.db.prepare("UPDATE routing SET state='decided',decision=? WHERE event_id=?").run(JSON.stringify(stored),eventId);
      return {eventId,input,state:"decided",decision:stored};
    });
  }
  updateAction(eventId: string, action: RoutingAction) {
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT decision FROM routing WHERE event_id=?").get(eventId) as {decision:string|null}|undefined;
      if (!row?.decision) throw new Error("Routing decision is missing");
      const decision=JSON.parse(row.decision) as NonNullable<RoutingRecord["decision"]>;
      const index=decision.actions.findIndex((candidate)=>candidate.id===action.id);
      if(index<0) throw new Error("Unknown routing action");
      decision.actions[index]={...decision.actions[index]!,...action};
      this.db.prepare("UPDATE routing SET decision=? WHERE event_id=?").run(JSON.stringify(decision),eventId);
    });
  }
  finishRoute(eventId: string) { this.db.prepare("UPDATE routing SET state='handled' WHERE event_id=? AND decision IS NOT NULL").run(eventId); }
  enqueueRoutedRequest(eventId: string, actionId: string) {
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT decision FROM routing WHERE event_id=?").get(eventId) as {decision:string|null}|undefined;
      const decision = row?.decision ? JSON.parse(row.decision) as NonNullable<RoutingRecord["decision"]> : undefined;
      const index=decision?.actions.findIndex((action)=>action.id===actionId) ?? -1;
      const action=decision?.actions[index];
      if(!action || !["request","clarify"].includes(action.kind)) throw new Error("Unknown request action");
      const input=this.getInput(eventId)!;
      if(decision?.reason || action.reason) input.runtimeMaterials=[...(input.runtimeMaterials??[]),...[decision?.reason,action.reason].filter((value): value is string => Boolean(value))];
      this.addWork(input,actionId,index,action.text);
      return this.listWorks(input.conversationId).find((work)=>work.id===actionId)!;
    });
  }
  listWorks(conversationId?: string): QueueWork[] {
    const rows=this.db.prepare(`SELECT * FROM works ${conversationId ? "WHERE conversation=?" : ""} ORDER BY sequence,ordinal`).all(...(conversationId?[conversationId]:[])) as WorkRow[];
    return rows.map((row)=>{const input={...JSON.parse(row.payload),eventId:row.event_id,sequence:row.sequence,targetId:row.id} as PersistedInput;
      return {id:row.id,conversationId:row.conversation,inputId:input.inputId,eventId:row.event_id,summary:Array.from(input.actionText??input.userText??input.text).slice(0,512).join(""),status:row.status,batchId:row.batch_id??undefined,submissionId:row.submission??undefined,input};});
  }
  requeueAction(eventId: string, actionId: string, reason: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT decision FROM routing WHERE event_id=?").get(eventId) as {decision:string}|undefined;
      if (!row) throw new Error("Routing decision is missing");
      const decision = JSON.parse(row.decision) as NonNullable<RoutingRecord["decision"]>;
      const index = decision.actions.findIndex(action => action.id === actionId);
      if (index < 0) throw new Error("Routing action is missing");
      const action = {...decision.actions[index]!,kind:"request" as const,state:"handled" as const,reason};
      decision.actions[index] = action;
      this.db.prepare("UPDATE routing SET decision=? WHERE event_id=?").run(JSON.stringify(decision),eventId);
      const input = this.getInput(eventId)!;
      input.runtimeMaterials = [...(input.runtimeMaterials??[]),reason];
      this.addWork(input,actionId,index,action.text);
      return this.listWorks(input.conversationId).find(work => work.id === actionId)!;
    });
  }
  supplementWork(targetId: string, input: PersistedInput, actionId: string) {
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT * FROM works WHERE id=?").get(targetId) as WorkRow|undefined;
      if(!row || row.conversation!==input.conversationId) throw new Error("Unknown supplement target");
      if(row.status==="cancelled") return false;
      const payload=JSON.parse(row.payload) as PersistedInput;
      const supplements=payload.supplements??[];
      if(!supplements.some((entry)=>entry.actionId===actionId)) supplements.push({...input,actionId});
      supplements.sort((a,b)=>a.sequence-b.sequence || Number(a.actionId.split(":").at(-1))-Number(b.actionId.split(":").at(-1)));
      this.db.prepare("UPDATE works SET payload=? WHERE id=?").run(JSON.stringify({...payload,supplements}),targetId);
      return true;
    });
  }
  cancelWork(targetId: string, helper = false) {
    return this.transaction(()=>{
      const work=this.db.prepare("SELECT * FROM works WHERE id=?").get(targetId) as WorkRow|undefined;
      if(work && work.status!=="cancelled" && (helper || work.status!=="completed")) {
        this.db.prepare("UPDATE works SET status='cancelled' WHERE id=?").run(targetId);
        // Cancellation changes the submitted scope. Persist a fresh-attempt handoff
        // with the tombstone, before the caller can request a cooperative abort.
        if(work.batch_id) this.db.prepare("UPDATE batches SET status='preempted' WHERE id=? AND status='running'").run(work.batch_id);
      }
      return this.listWorks().find((candidate)=>candidate.id===targetId);
    });
  }
  conversations(): string[] {
    return (this.db.prepare("SELECT conversation FROM inputs UNION SELECT conversation FROM internal_results").all() as Array<{conversation: string}>)
      .map((row) => row.conversation);
  }
  private hydrate(row: BatchRow, resumed: boolean): ProcessingBatch {
    const inputs = this.db.prepare("SELECT event_id AS id,sequence,payload,ordinal,id AS target_id FROM works WHERE batch_id=? AND status!='cancelled' UNION ALL SELECT id,sequence,payload,0 AS ordinal,NULL AS target_id FROM internal_results WHERE batch_id=? ORDER BY sequence,ordinal")
      .all(row.id,row.id) as Array<{ id: string; sequence: number; payload: string; target_id: string | null }>;
    return { id: row.id, requestKey: row.request_key, conversationId: row.conversation,
      events: inputs.map((event) => ({ ...JSON.parse(event.payload), eventId: event.id, sequence: event.sequence, ...(event.target_id ? {targetId:event.target_id} : {}) })),
      submissionId: row.submission === null ? undefined : String(row.submission),
      previousSubmissionId: row.previous_submission === null ? undefined : String(row.previous_submission),
      resumed, reconcile: Boolean(row.reconcile), retryEpoch: row.retry_epoch ?? 0 };
  }
  claim(conversationId: string): ProcessingBatch | undefined {
    return this.transaction(() => {
      let ceiling = this.snapshots.get(conversationId);
      if (ceiling === undefined) {
        ceiling = (this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM inputs WHERE conversation=?").get(conversationId) as {sequence:number}).sequence;
        this.snapshots.set(conversationId,ceiling);
      }
      if (this.db.prepare("SELECT 1 FROM routing r JOIN inputs i ON i.id=r.event_id WHERE i.conversation=? AND i.sequence<=? AND r.state!='handled' LIMIT 1").get(conversationId,ceiling)) return undefined;
      // A cancelled target remains a tombstone even if its old batch is resumed.
      this.db.prepare("UPDATE batches SET status='completed' WHERE conversation=? AND status IN ('running','preempted') AND NOT EXISTS(SELECT 1 FROM works WHERE batch_id=batches.id AND status!='cancelled') AND NOT EXISTS(SELECT 1 FROM internal_results WHERE batch_id=batches.id)").run(conversationId);
      const interrupted = this.db.prepare("SELECT * FROM batches WHERE conversation=? AND status IN ('running','preempted') ORDER BY priority DESC, rowid LIMIT 1")
        .get(conversationId) as BatchRow | undefined;
      const head = this.db.prepare("SELECT sequence,priority,source,kind,'works' AS origin FROM works WHERE conversation=? AND sequence<=? AND batch_id IS NULL AND status='queued' UNION ALL SELECT sequence,priority,source,kind,'internal_results' AS origin FROM internal_results WHERE conversation=? AND batch_id IS NULL ORDER BY priority DESC, sequence LIMIT 1")
        .get(conversationId,ceiling,conversationId) as { sequence: number; priority: number; source: string; kind: string; origin: string } | undefined;
      this.snapshots.delete(conversationId);
      if (interrupted && (!head || interrupted.priority >= head.priority)) {
        if (interrupted.status === "preempted") {
          interrupted.attempt++;
          interrupted.request_key = `batch:${interrupted.id}:${interrupted.attempt}`;
          interrupted.previous_submission = interrupted.submission ?? interrupted.previous_submission;
          interrupted.submission = null;
          interrupted.reconcile = 1;
          interrupted.status = "running";
          this.db.prepare("UPDATE batches SET attempt=?,request_key=?,previous_submission=?,submission=NULL,reconcile=1,status='running' WHERE id=?")
            .run(interrupted.attempt, interrupted.request_key, interrupted.previous_submission, interrupted.id);
        }
        return this.hydrate(interrupted, true);
      }
      if (!head) return undefined;
      const pending = this.db.prepare(`SELECT id,sequence,source,priority,kind FROM ${head.origin} WHERE conversation=? AND batch_id IS NULL ${head.origin === "works" ? `AND status='queued' AND sequence<=${ceiling}` : ""} AND sequence>=? ORDER BY sequence${head.origin === "works" ? ",ordinal" : ""}`)
        .all(conversationId, head.sequence) as Array<{ id: string; sequence: number; source: string; priority: number; kind: string }>;
      const members: string[] = [];
      for (const event of pending) {
        if (members.length && (head.kind !== "message" || event.kind !== "message" || event.source !== head.source || event.priority !== head.priority)) break;
        members.push(event.id);
        if (head.kind !== "message") break;
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO batches(id,conversation,request_key,priority,status) VALUES(?,?,?,?,'running')")
        .run(id, conversationId, `batch:${id}`, head.priority);
      const assign = this.db.prepare(`UPDATE ${head.origin} SET batch_id=?${head.origin === "works" ? ",status='running'" : ""} WHERE id=?`);
      for (const member of members) assign.run(id, member);
      return this.hydrate({ id, conversation: conversationId, request_key: `batch:${id}`, priority: head.priority,
        status: "running", submission: null, previous_submission: null, attempt: 0, reconcile: 0 }, false);
    });
  }
  recordSubmission(batchId: string, submissionId: string) {
    this.transaction(()=>{
      this.db.prepare("UPDATE batches SET submission=? WHERE id=?").run(submissionId, batchId);
      this.db.prepare("UPDATE works SET submission=? WHERE batch_id=? AND status!='cancelled'").run(submissionId,batchId);
    });
  }
  getBatch(batchId: string): StoredBatch | undefined {
    const row = this.db.prepare("SELECT * FROM batches WHERE id=?").get(batchId) as BatchRow|undefined;
    return row ? {...this.hydrate(row,true),status:row.status,reason:row.reason??undefined} : undefined;
  }
  listBatches(conversationId?: string, statuses?: BatchStatus[]): StoredBatch[] {
    const rows = (conversationId
      ? this.db.prepare("SELECT * FROM batches WHERE conversation=? ORDER BY rowid").all(conversationId)
      : this.db.prepare("SELECT * FROM batches ORDER BY rowid").all()) as BatchRow[];
    return rows.filter((row)=>!statuses||statuses.includes(row.status))
      .map((row)=>({...this.hydrate(row,true),status:row.status,reason:row.reason??undefined}));
  }
  listPending(conversationId?: string): PersistedInput[] {
    const rows = (conversationId
      ? this.db.prepare("SELECT event_id AS id,sequence,payload FROM works WHERE batch_id IS NULL AND status='queued' AND conversation=? ORDER BY sequence,ordinal").all(conversationId)
      : this.db.prepare("SELECT event_id AS id,sequence,payload FROM works WHERE batch_id IS NULL AND status='queued' ORDER BY sequence,ordinal").all()) as Array<{id:string;sequence:number;payload:string}>;
    return rows.map((row)=>({...JSON.parse(row.payload),eventId:row.id,sequence:row.sequence}));
  }
  settle(batchId: string, status: Exclude<BatchStatus, "running">, reason?: string) {
    this.transaction(()=>{
      this.db.prepare("UPDATE batches SET status=?,reason=? WHERE id=?").run(status, reason ?? null, batchId);
      this.db.prepare("UPDATE works SET status=? WHERE batch_id=? AND status!='cancelled'").run(status==="preempted" ? "running" : status,batchId);
    });
  }
  recoverSteerTarget(batchId: string) {
    this.transaction(()=>{
      this.db.prepare("UPDATE batches SET status='running' WHERE id=? AND status='completed'").run(batchId);
      this.db.prepare("UPDATE works SET status='running' WHERE batch_id=? AND status='completed'").run(batchId);
    });
  }
  resume(conversationId: string, batchId?: string) {
    return this.transaction(() => {
      const candidates = this.db.prepare(`SELECT id FROM batches WHERE conversation=? AND status IN ('paused','needs_confirmation')${batchId ? " AND id=?" : ""}`)
        .all(conversationId, ...(batchId ? [batchId] : [])) as Array<{id:string}>;
      const selected = candidates[0];
      if (!selected || candidates.length > 1) return {resumed:false,paused:candidates.length};
      this.db.prepare("UPDATE batches SET status='preempted',retry_epoch=retry_epoch+1 WHERE id=?").run(selected.id);
      this.db.prepare("UPDATE works SET status='running' WHERE batch_id=? AND status IN ('paused','needs_confirmation')").run(selected.id);
      return {resumed:true,paused:1};
    });
  }
  close() { this.db.close(); }
}
