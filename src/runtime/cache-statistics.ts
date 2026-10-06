import type { StoredEvent } from "./runtime-types.js";
import { conversationOwnership } from "./conversation-log.js";

export type CacheTotals = { hit: number; miss: number; input: number; hitRate: number | null; calls: number; measured: number; pending: number };
export type CacheRun = { runId: string; state: string; startedAt?: string; completedAt: string; execution: CacheTotals; auxiliary: CacheTotals };
export type CacheReport = { conversationId: string; recent: CacheRun[]; current?: CacheRun; execution: CacheTotals; auxiliary: CacheTotals; unassignedCalls: number };
type Usage = { hit: number; miss: number };
type Call = { runId?: string; owner?: string; purpose: string; usage?: Usage; telemetry?: boolean; settled: boolean };

function measuredUsage(value: unknown, available?: unknown): Usage | undefined {
  if (available === false || !value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const hit = usage.cacheRead; const input = usage.input; const write = usage.cacheWrite ?? 0;
  if (typeof input !== "number" || typeof write !== "number" || !Number.isSafeInteger(input) || !Number.isSafeInteger(write) || input < 0 || write < 0) return undefined;
  const miss = input + write;
  if (typeof hit !== "number" || typeof miss !== "number" || !Number.isSafeInteger(hit) || !Number.isSafeInteger(miss) || hit < 0 || miss < 0) return undefined;
  // Historical SDK failures synthesize all-zero usage. Only explicit telemetry can certify a measured zero.
  if (available !== true && hit + miss === 0) return undefined;
  return { hit, miss };
}

function totals(calls: Call[]): CacheTotals {
  const hit = calls.reduce((sum, call) => sum + (call.usage?.hit ?? 0), 0);
  const miss = calls.reduce((sum, call) => sum + (call.usage?.miss ?? 0), 0);
  return { hit, miss, input: hit + miss, hitRate: hit + miss ? hit / (hit + miss) : null,
    calls: calls.length, measured: calls.filter((call) => call.usage).length,
    pending: calls.filter((call) => !call.settled).length };
}

/** One immutable log snapshot; no counters are reset with active context. */
export function cacheStatistics(events: StoredEvent[], conversationId: string): CacheReport {
  const owners = conversationOwnership(events);
  const calls = new Map<string, Call>();
  const terminals = new Map<string, { state: string; completedAt: string; index: number }>();
  const starts = new Map<string, { startedAt: string; index: number }>();
  const hostStates: Record<string, string> = { run_succeeded: "succeeded", run_failed: "failed", run_cancelled: "cancelled" };
  const legacyStates: Record<string, string> = { request_completed: "succeeded", request_failed: "failed", request_interrupted: "cancelled" };
  for (const [index, event] of events.entries()) {
    const runId = event.requestId ?? (typeof event.runId === "string" ? event.runId : undefined);
    const state = hostStates[event.type] ?? legacyStates[event.type];
    if (runId && state && (hostStates[event.type] || !terminals.has(runId))) terminals.set(runId, { state, completedAt: event.at, index });
    if (runId && (event.type === "request_started" || event.type === "model_step_started") && !starts.has(runId))
      starts.set(runId, { startedAt: event.at, index });
    if (!["model_step_started", "model_call_started", "model_step_completed", "model_message", "model_usage"].includes(event.type)) continue;
    const identity = event.callId ?? event.modelStepId ?? (event.step !== undefined ? `${runId}:step:${event.step}` : event.eventId ?? `legacy:${index}`);
    const key = `${runId ?? "unbound"}:${String(identity)}`;
    const prior = calls.get(key);
    const message = event.type === "model_message" ? event.message as { usage?: unknown } | undefined : undefined;
    const usage = prior?.telemetry && event.type !== "model_usage" ? prior.usage : event.type === "model_usage" ? measuredUsage(event.usage, event.usageAvailable) :
      message ? measuredUsage(message.usage, event.usageAvailable) : prior?.usage;
    calls.set(key, { runId, owner: typeof event.conversationId === "string" ? event.conversationId : runId ? owners.get(runId) : undefined,
      purpose: typeof event.purpose === "string" ? event.purpose : prior?.purpose ?? "execution",
      settled: prior?.settled || ["model_message", "model_usage", "model_step_completed"].includes(event.type),
      telemetry: prior?.telemetry || event.type === "model_usage",
      ...(usage ? { usage } : {}) });
  }
  const own = [...calls.values()].filter((call) => call.owner === conversationId);
  const execution = own.filter((call) => call.purpose === "execution");
  const auxiliary = own.filter((call) => call.purpose !== "execution");
  const recent = [...terminals.entries()].filter(([runId]) => execution.some((call) => call.runId === runId))
    .sort((left, right) => right[1].index - left[1].index).slice(0, 5)
    .map(([runId, terminal]) => ({ runId, state: terminal.state, startedAt: starts.get(runId)?.startedAt, completedAt: terminal.completedAt,
      // A terminal Run cannot still have pending calls; unreturned usage is missing.
      execution: totals(execution.filter((call) => call.runId === runId).map((call) => ({ ...call, settled: true }))),
      auxiliary: totals(auxiliary.filter((call) => call.runId === runId).map((call) => ({ ...call, settled: true }))) }));
  const active = [...starts.entries()].filter(([runId]) => !terminals.has(runId) && owners.get(runId) === conversationId)
    .sort((left, right) => right[1].index - left[1].index)[0];
  const current = active ? { runId: active[0], state: "running", startedAt: active[1].startedAt, completedAt: "",
    execution: totals(execution.filter((call) => call.runId === active[0])), auxiliary: totals(auxiliary.filter((call) => call.runId === active[0])) } : undefined;
  const settledOwn = (values: Call[]) => values.map((call) => call.runId && terminals.has(call.runId) ? { ...call, settled: true } : call);
  return { conversationId, recent: recent.slice(0, current ? 4 : 5), ...(current ? { current } : {}), execution: totals(settledOwn(execution)), auxiliary: totals(settledOwn(auxiliary)),
    unassignedCalls: [...calls.values()].filter((call) => !call.owner).length };
}

function line(totals: CacheTotals): string {
  const rate = totals.hitRate === null ? "不可用" : `${(totals.hitRate * 100).toFixed(2)}%`;
  const number = (value: number) => value.toLocaleString("en-US");
  const missing = totals.calls - totals.measured - totals.pending;
  const notes = [totals.pending ? `待结算 ${totals.pending} 次` : "", missing ? `数据缺失 ${missing} 次` : ""].filter(Boolean);
  return `缓存命中率：**${rate}**\n♻️ 命中（Hit）：${number(totals.hit)} token\n🆕 未命中（Miss）：${number(totals.miss)} token\n合计输入：${number(totals.input)} token` +
    (notes.length ? `\n${notes.join("；")}，以上仅计已返回的有效用量。` : "");
}

export function cacheReportText(report: CacheReport): string {
  const runs = [...(report.current ? [report.current] : []), ...report.recent];
  const states: Record<string, string> = { running: "当前运行 · 进行中", failed: "失败", cancelled: "已取消" };
  const rows = runs.map((run, index) => `${index + 1}.${states[run.state] ? ` ${states[run.state]}` : ""}\n${line(run.execution)}`);
  return ["🦖 **【奶龙赛博反刍胃囊报表】**", rows.length ? rows.join("\n\n") : "暂无模型运行数据。"].join("\n\n");
}
