export type MemoryBudget = { maxTokens?: number; ratio?: number };
export type OriginalMemoryCoverage = { kind: "original"; nodeId: string; messageId: string;
  offset: number; end: number; complete: boolean };
export function memoryBudget(inputBudget: number, config: MemoryBudget = {}): number {
  const max = config.maxTokens ?? 4096; const ratio = config.ratio ?? 0.1;
  if (!Number.isSafeInteger(max) || max < 0 || max > 4096 || !Number.isFinite(ratio) || ratio < 0 || ratio > 0.1) throw new Error("记忆预算无效");
  return Math.floor(Math.min(max, inputBudget * ratio));
}
