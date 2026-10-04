import type { StoredEvent } from "./runtime-types.js";
import { conversationOwnership } from "./conversation-log.js";

export type CacheTotals = { hit: number; miss: number; input: number; hitRate: number | null; calls: number; measured: number };
export type CacheRun = { runId: string; state: string; completedAt: string; execution: CacheTotals; auxiliary: CacheTotals };
export type CacheReport = { conversationId: string; recent: CacheRun[]; execution: CacheTotals; auxiliary: CacheTotals; unassignedCalls: number };
type Usage = { hit: number; miss: number };
type Call = { runId?: string; owner?: string; purpose: string; usage?: Usage; telemetry?: boolean };

function measuredUsage(value: unknown, available?: unknown): Usage | undefined {
  if (available === false || !value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const hit = usage.cacheRead; const miss = usage.input;
  if (typeof hit !== "number" || typeof miss !== "number" || !Number.isSafeInteger(hit) || !Number.isSafeInteger(miss) || hit < 0 || miss < 0) return undefined;
  // Historical SDK failures synthesize all-zero usage. Only explicit telemetry can certify a measured zero.
  if (available !== true && hit + miss === 0) return undefined;
  return { hit, miss };
}

function totals(calls: Call[]): CacheTotals {
  const hit = calls.reduce((sum, call) => sum + (call.usage?.hit ?? 0), 0);
  const miss = calls.reduce((sum, call) => sum + (call.usage?.miss ?? 0), 0);
  return { hit, miss, input: hit + miss, hitRate: hit + miss ? hit / (hit + miss) : null,
    calls: calls.length, measured: calls.filter((call) => call.usage).length };
}

/** One immutable log snapshot; no counters are reset with active context. */
export function cacheStatistics(events: StoredEvent[], conversationId: string): CacheReport {
  const owners = conversationOwnership(events);
  const calls = new Map<string, Call>();
  const terminals = new Map<string, { state: string; completedAt: string; index: number }>();
  const hostStates: Record<string, string> = { run_succeeded: "succeeded", run_failed: "failed", run_cancelled: "cancelled" };
  const legacyStates: Record<string, string> = { request_completed: "succeeded", request_failed: "failed", request_interrupted: "cancelled" };
  for (const [index, event] of events.entries()) {
    const runId = event.requestId ?? (typeof event.runId === "string" ? event.runId : undefined);
    const state = hostStates[event.type] ?? legacyStates[event.type];
    if (runId && state && (hostStates[event.type] || !terminals.has(runId))) terminals.set(runId, { state, completedAt: event.at, index });
    if (!["model_step_started", "model_call_started", "model_message", "model_usage"].includes(event.type)) continue;
    const identity = event.callId ?? event.modelStepId ?? (event.step !== undefined ? `${runId}:step:${event.step}` : event.eventId ?? `legacy:${index}`);
    const key = `${runId ?? "unbound"}:${String(identity)}`;
    const prior = calls.get(key);
    const message = event.type === "model_message" ? event.message as { usage?: unknown } | undefined : undefined;
    const usage = prior?.telemetry && event.type !== "model_usage" ? prior.usage : event.type === "model_usage" ? measuredUsage(event.usage, event.usageAvailable) :
      message ? measuredUsage(message.usage, event.usageAvailable) : prior?.usage;
    calls.set(key, { runId, owner: typeof event.conversationId === "string" ? event.conversationId : runId ? owners.get(runId) : undefined,
      purpose: typeof event.purpose === "string" ? event.purpose : prior?.purpose ?? "execution",
      telemetry: prior?.telemetry || event.type === "model_usage",
      ...(usage ? { usage } : {}) });
  }
  const own = [...calls.values()].filter((call) => call.owner === conversationId);
  const execution = own.filter((call) => call.purpose === "execution");
  const auxiliary = own.filter((call) => call.purpose !== "execution");
  const recent = [...terminals.entries()].filter(([runId]) => execution.some((call) => call.runId === runId))
    .sort((left, right) => right[1].index - left[1].index).slice(0, 4)
    .map(([runId, terminal]) => ({ runId, state: terminal.state, completedAt: terminal.completedAt,
      execution: totals(execution.filter((call) => call.runId === runId)), auxiliary: totals(auxiliary.filter((call) => call.runId === runId)) }));
  return { conversationId, recent, execution: totals(execution), auxiliary: totals(auxiliary),
    unassignedCalls: [...calls.values()].filter((call) => !call.owner).length };
}

function line(totals: CacheTotals): string {
  const rate = totals.hitRate === null ? "不可用" : `${(totals.hitRate * 100).toFixed(2)}%`;
  return `命中 ${totals.hit} / 未命中 ${totals.miss} / 输入 ${totals.input} token；命中率 ${rate}；数据 ${totals.measured}/${totals.calls} 次调用${totals.measured < totals.calls ? "（数据缺失，以上仅为已测量部分）" : ""}`;
}

export function cacheReportText(report: CacheReport): string {
  const rows = report.recent.map((run, index) => `${index + 1}. ${run.runId} · ${run.state} · ${run.completedAt}\n${line(run.execution)}${run.auxiliary.calls ? `\n辅助：${line(run.auxiliary)}` : ""}`);
  return [`KV cache · ${report.conversationId}`,
    `查询快照：${new Date().toISOString()}（UTC）。统计截至查询时已返回的 usage，已发送消息不会自动刷新；重新 /kvcache 查看更新数据。`,
    "最近 4 次模型 Run（时间戳为 UTC）：", rows.length ? rows.join("\n\n") : "暂无已结束的模型 Run。",
    `Conversation 累计执行：${line(report.execution)}`, `辅助调用（摘要等）：${line(report.auxiliary)}`,
    "费用估算：不可用；统计依据 Provider 已返回的 usage，不代表账单。",
    ...(report.unassignedCalls ? [`旧日志中 ${report.unassignedCalls} 次调用未能可靠归属，未计入当前 Conversation。`] : [])].join("\n\n");
}
