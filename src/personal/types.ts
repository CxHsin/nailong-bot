export type TaskStatus = 'queued' | 'running' | 'stopping' | 'cancelled' | 'completed' | 'partial' | 'failed' | 'waiting';
export interface ExecutorIdentity { kind: string; [key: string]: unknown }
export interface Usage { input?: number; output?: number; cost?: number; costKnown?: boolean }
export interface TaskResult { text: string; verified: boolean; artifacts?: string[]; artifactDigests?: Record<string, string>; partial?: boolean; producedRevision?: number;
  sources?: Array<{ reference: string; excerpt: string; supports?: string[]; receiptId?: string; kind?: 'local' | 'remote'; provider?: string }>;
  invalidMaterials?: Array<{ reference: string; reason: string }>;
  uncertainties?: string;
  operations?: Array<{ operation: string; before: Array<{ path: string; sha256: string | null }>; after: Array<{ path: string; sha256: string | null }> }>;
  manifest?: Array<{ path: string; bytes: number; sha256: string }>;
  checks?: Array<{ command: string; status: string; revision: number; taskId?: string; parentRevision?: number }>;
}
export interface Task {
  id: string; conversationId: string; actorId: string; goal: string; resources: string[];
  executor: 'local' | 'herdr'; cwd?: string; sessionId: string; status: TaskStatus;
  createdAt: number; updatedAt: number; result?: TaskResult; error?: string; requirements: string[]; revision: number;
  resourceHeld?: boolean; cancelRequested?: boolean;
  requirementInputs?: string[];
  contextExcluded?: boolean;
  deadline?: number;
  workKind?: 'root' | 'delegation';
  parentTaskId?: string;
  rootTaskId?: string;
  direct?: boolean;
  originInputId?: string;
  permission?: PermissionGrant;
  purpose?: 'research' | 'organization' | 'coding';
  parentRevision?: number;
  delegationIdentity?: string;
  background?: string;
  originInput?: PersonalInput;
  contextPacket?: ContextPacket;
  contextRequestId?: string;
}
export interface PermissionGrant {
  mode: 'restricted' | 'trusted'; readRoots: string[]; writeRoots: string[]; network: boolean;
  expiresAt: number; revision: number; sourceInputId: string; deleteOriginal?: boolean; externalSend?: boolean;
}
export interface WorkToolContext {
  task: Task; eventId?: string;
  current(): Task;
  requestAction(action: ActionSpec): Promise<boolean>;
  proposePermission(grant: Omit<PermissionGrant, 'revision' | 'sourceInputId'>): Promise<boolean>;
  dispatch<T>(callId: string, action: ActionSpec, execute: () => Promise<T>): Promise<T>;
  send(text: string): Delivery;
  delegate?(callId: string, spec: DelegationSpec): Task;
  reserveModelCall?(): void;
  accountModelUsage?(usage: Usage): void;
  materialActions?(): ActionDispatch[];
  controlChild?(callId: string, taskId: string, operation: 'query' | 'steer' | 'cancel', text?: string): Promise<PersonalResponse>;
  agreements?(): WorkingAgreement[];
  proposeAgreement?(change: AgreementChange): PersonalResponse;
  requestContext?(callId: string, query: string): WorkEvent;
}
export interface Attempt {
  id: string; taskId: string; sessionId: string; status: TaskStatus; startedAt: number;
  finishedAt?: number; identity?: ExecutorIdentity; usage?: Usage;
  startedRevision?: number;
  presentedRevision?: number;
}
export interface SessionReceipt { sessionId: string; entryId: string; at: number }
export interface WorkBudget { id: string; calls: number; tokens: number; rework: number; costKnown: boolean; cost?: number }
export interface AgreementScope { kind: 'work' | 'project' | 'global'; id?: string }
export interface AgreementChange { operation: 'save' | 'edit' | 'revoke'; id?: string; content?: string; scope?: AgreementScope }
export interface WorkingAgreement { id: string; actorId: string; conversationId: string; content: string; scope: AgreementScope; revision: number; state: 'active' | 'revoked'; sourceInputId: string; confirmedInputId: string; at: number; history: Array<{ content: string; scope: AgreementScope; revision: number; state: 'active' | 'revoked'; confirmedInputId: string }> }
export interface ContextReference { nodeId: string; messageId: string; offset?: number; limit?: number }
export interface ContextPacket { version: 1; content: string; spans: import('./memory-context.js').MemorySpan[]; agreementIds: string[]; source: 'parent_selected'; at: number }
export interface DelegationSpec { goal: string; purpose: 'research' | 'organization' | 'coding'; cwd?: string; resources?: string[]; background?: string; permission?: PermissionGrant; reworkOf?: string; contextPacket?: ContextPacket }
export interface ContinuationOutcome { outcome: 'completed' | 'waiting' | 'blocked' | 'needs_decision'; reviewedRevision: number; result?: TaskResult; text?: string; completion: SessionReceipt; contextResponse?: ContextPacket }
export interface ContinuationContext { task: Task; sessionId: string; tasks: Task[]; work(): WorkToolContext; onInjection(receipt: SessionReceipt): void; signal: AbortSignal }
export interface WorkEvent {
  id: string; kind: 'delegation_result' | 'requirements_changed' | 'direct_completion' | 'context_request'; conversationId: string;
  query?: string;
  taskId: string; parentTaskId: string; rootTaskId: string; attemptId: string;
  revision: number; result?: TaskResult; createdAt: number;
  state: 'pending' | 'processing' | 'consumed' | 'blocked' | 'unknown';
  injection?: SessionReceipt; completion?: SessionReceipt;
  error?: string;
}
export interface ActionDispatch {
  id: string; taskId: string; eventId?: string; attemptId?: string; revision: number;
  action: ActionSpec; status: 'dispatching' | 'succeeded' | 'failed' | 'unknown';
  startedAt: number; finishedAt?: number; evidence?: string;
}
export interface PersonalInput { conversationId: string; actorId: string; text: string; inputId: string; replyTaskId?: string;
  origin?: 'plan';
  receivedAt?: number;
  images?: Array<{ type: 'image'; mimeType: string; data: string }>; }
export interface Plan {
  id: string; conversationId: string; actorId: string; goal: string; cwd?: string;
  executor?: 'local' | 'herdr'; resources?: string[];
  status: 'active' | 'paused' | 'cancelled' | 'waiting' | 'completed';
  dueAt?: number; timezone: string; intervalMs?: number; afterTaskId?: string;
  deadline?: number; missed: 'skip' | 'run' | 'ask'; version: number;
  lastTrigger?: string; pendingTrigger?: string; createdAt: number;
  contextExcluded?: boolean;
  operationInputs?: string[];
}
export interface ActionSpec { kind: string; target: string; parameters: Record<string, unknown>; content: string }
export interface ActionRecord { id: string; taskId: string; revision: number; fingerprint: string; action: ActionSpec; status: 'pending' | 'approved' | 'denied' | 'consumed'; createdAt: number; proposedInputId?: string }
export type Decision = { kind: 'reply'; text: string } | { kind: 'complete'; taskId: string; outcome: ContinuationOutcome; injection: SessionReceipt } |
  { kind: 'start'; goal: string; resources?: string[]; executor?: 'local' | 'herdr'; cwd?: string; deadline?: number } |
  { kind: 'query' | 'cancel' | 'steer'; taskId?: string; text?: string } |
  { kind: 'authorize'; actionId: string; approved: boolean } |
  { kind: 'schedule'; plan: Omit<Plan, 'id' | 'conversationId' | 'actorId' | 'status' | 'version' | 'lastTrigger' | 'pendingTrigger' | 'createdAt'> } |
  { kind: 'plan'; planId?: string; action: 'pause' | 'cancel' | 'resume' | 'query' | 'change'; dueAt?: number; deadline?: number; goal?: string; intervalMs?: number | null; timezone?: string; missed?: 'skip' | 'run' | 'ask' } |
  { kind: 'redeliver'; taskId?: string; confirmUnknown?: boolean };
export interface Dialogue { decide(input: PersonalInput, context: { tasks: Task[]; sessionId: string; plans?: Plan[]; actions?: ActionRecord[]; work?: () => WorkToolContext }): Promise<Decision>;
  resume?(event: WorkEvent, context: ContinuationContext): Promise<ContinuationOutcome>;
  inspectContinuation?(event: WorkEvent, sessionId: string): Promise<{ state: 'absent' | 'injected' | 'completed' | 'unknown'; injection?: SessionReceipt; outcome?: ContinuationOutcome }>;
}
export interface TaskExecution {
  task: Task; attempt: Attempt; signal: AbortSignal;
  onIdentity(identity: ExecutorIdentity): void; onUsage(usage: Usage): void;
  onRequirementApplied?(revision: number): void;
  requestAction?(action: ActionSpec): Promise<boolean>;
}
export interface TaskExecutor {
  execute(request: TaskExecution): Promise<TaskResult>;
  steer?(taskId: string, text: string): Promise<boolean>;
  cancel?(identity: ExecutorIdentity): Promise<boolean>;
  inspect?(identity: ExecutorIdentity): Promise<{ state: 'running' | 'completed' | 'stopped' | 'unknown' | 'resumable'; result?: TaskResult }>;
}
export interface Delivery {
  id: string; conversationId: string; actorId: string; taskId?: string; text: string; artifacts?: string[];
  status: 'pending' | 'sending' | 'sent' | 'rejected' | 'unknown'; providerMessageId?: string; createdAt: number;
  parentId?: string; kind?: 'text' | 'file'; path?: string;
  artifactDigests?: Record<string, string>;
  attempts?: number; learningRecorded?: boolean;
  learning?: { id: string; input: string; answer: string; recallId?: string; originInputId?: string; inputAt?: number };
}
export interface PersonalResponse { text: string; taskId?: string; deliveryId?: string }
