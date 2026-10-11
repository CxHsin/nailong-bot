export type TaskStatus = 'queued' | 'running' | 'stopping' | 'cancelled' | 'completed' | 'partial' | 'failed' | 'waiting';
export interface ExecutorIdentity { kind: string; [key: string]: unknown }
export interface Usage { input?: number; output?: number; cost?: number; costKnown?: boolean }
export interface TaskResult { text: string; verified: boolean; artifacts?: string[]; artifactDigests?: Record<string, string>; partial?: boolean }
export interface Task {
  id: string; conversationId: string; actorId: string; goal: string; resources: string[];
  executor: 'local' | 'herdr'; cwd?: string; sessionId: string; status: TaskStatus;
  createdAt: number; updatedAt: number; result?: TaskResult; error?: string; requirements: string[]; revision: number;
  resourceHeld?: boolean; cancelRequested?: boolean;
  requirementInputs?: string[];
  contextExcluded?: boolean;
  deadline?: number;
}
export interface Attempt {
  id: string; taskId: string; sessionId: string; status: TaskStatus; startedAt: number;
  finishedAt?: number; identity?: ExecutorIdentity; usage?: Usage;
}
export interface PersonalInput { conversationId: string; actorId: string; text: string; inputId: string; replyTaskId?: string;
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
export interface ActionRecord { id: string; taskId: string; revision: number; fingerprint: string; action: ActionSpec; status: 'pending' | 'approved' | 'denied' | 'consumed'; createdAt: number }
export type Decision = { kind: 'reply'; text: string } |
  { kind: 'start'; goal: string; resources?: string[]; executor?: 'local' | 'herdr'; cwd?: string; deadline?: number } |
  { kind: 'query' | 'cancel' | 'steer'; taskId?: string; text?: string } |
  { kind: 'authorize'; actionId: string; approved: boolean } |
  { kind: 'schedule'; plan: Omit<Plan, 'id' | 'conversationId' | 'actorId' | 'status' | 'version' | 'lastTrigger' | 'pendingTrigger' | 'createdAt'> } |
  { kind: 'plan'; planId?: string; action: 'pause' | 'cancel' | 'resume' | 'query' | 'change'; dueAt?: number; deadline?: number; goal?: string; intervalMs?: number | null; timezone?: string; missed?: 'skip' | 'run' | 'ask' } |
  { kind: 'redeliver'; taskId?: string; confirmUnknown?: boolean };
export interface Dialogue { decide(input: PersonalInput, context: { tasks: Task[]; sessionId: string; plans?: Plan[]; actions?: ActionRecord[] }): Promise<Decision> }
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
  learning?: { id: string; input: string; answer: string };
}
export interface PersonalResponse { text: string; taskId?: string; deliveryId?: string }
