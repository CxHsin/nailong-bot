export const MEMORY_ALGORITHM = "akasha-v1";
export type MemoryDynamics = { strengthMs: number; edgeMs: number; resourceMs: number; strengthCap: number; edgeCap: number;
  strengthRate: number; resourceRate: number; edgeRate: number; backwardRatio: number };
export const DEFAULT_DYNAMICS: MemoryDynamics = { strengthMs: 7 * 86400_000, edgeMs: 14 * 86400_000, resourceMs: 30 * 60_000,
  strengthCap: 3, edgeCap: 2, strengthRate: 0.18, resourceRate: 0.35, edgeRate: 0.12, backwardRatio: 0.25 };
export function memoryDynamics(config: Partial<MemoryDynamics> = {}): MemoryDynamics {
  const result = { ...DEFAULT_DYNAMICS, ...config };
  if (Object.values(result).some((value) => !Number.isFinite(value) || value < 0) ||
    [result.strengthMs, result.edgeMs, result.resourceMs, result.strengthCap, result.edgeCap].some((value) => value <= 0) ||
    result.backwardRatio > 1 || result.resourceRate > 1) throw new Error("记忆动力学配置无效");
  return result;
}
export function boundedAdd(value: number, delta: number, cap: number): number {
  if (![value, delta, cap].every(Number.isFinite) || cap <= 0 || delta < 0 || value < 0) throw new Error("记忆状态数值无效");
  const previous = Math.min(cap, value);
  return Math.min(cap, previous + Math.min(cap, delta) * (1 - previous / cap));
}
export function learningSignal(score: number): number {
  return Number.isFinite(score) && score > 0 ? score / (1 + score) : 0;
}
export function elapsed(now: number, previous: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(previous)) throw new Error("记忆结算时间无效");
  return Math.max(0, now - previous);
}
export function settleNode(state: { strength: number; resource: number; at: number }, now: number, config = DEFAULT_DYNAMICS) {
  if (![state.strength, state.resource].every(Number.isFinite)) throw new Error("记忆状态数值无效");
  const delta = elapsed(now, state.at);
  return { strength: Math.max(0, Math.min(config.strengthCap, state.strength)) * Math.exp(-delta / config.strengthMs),
    resource: 1 - (1 - Math.max(0, Math.min(1, state.resource))) * Math.exp(-delta / config.resourceMs), at: Math.max(now, state.at) };
}
