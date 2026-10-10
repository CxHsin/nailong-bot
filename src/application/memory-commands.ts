import { memoryNodes, memoryExclusions, memoryNodesForReply } from "../runtime/memory-facts.js";
import { invalidateMemoryIndex } from "../memory/cache.js";
import { createCheckpointStore } from "../context/checkpoint.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import type { CommandInput } from "./command-input.js";
import { appendRuntimeFact, appendRuntimeFacts } from "../runtime/facts.js";

export type MemoryCommandOptions = { dataDir: string; purgeEmbeddingCache?: () => void };

export async function handleMemoryCommand(log: RuntimeLog, options: MemoryCommandOptions, input: CommandInput, text: string, onStarted?: () => void): Promise<string | undefined> {
  if (input.hasAttachments) return undefined;
  const raw = /^\/memory\s+log\s+(\S+)(?:\s+(\d+))?$/.exec(text);
  if (raw) {
    const events = await log.read();
    const originals = memoryNodes(events.filter((event) => event.type !== "memory_excluded"), input.ownerId);
    await appendRuntimeFact(log, { type: "input_received", chatId: input.ownerId, messageId: input.messageId, intent: text,
      replyToMessageId: input.replyToMessageId, diagnosticInspection: true });
    onStarted?.();
    const node = originals.find((item) => item.id === raw[1]);
    if (!node) return "没有找到该原始轮次。";
    const offset = Number(raw[2] ?? 0);
    if (!Number.isSafeInteger(offset)) return "原始日志读取位置无效。";
    const body = node.messages.map((message) => `[${message.role} ${message.at} ${message.id}]\n${message.text}`).join("\n");
    const points = Array.from(body); const end = Math.min(points.length, offset + 1800);
    return `等等，让奶龙翻翻小本本……找到了这轮记录！\n原始日志诊断查阅，不恢复记忆、不参与强化：\n${points.slice(offset, end).join("")}\n${end < points.length ? `续读：/memory log ${node.id} ${end}` : "读取完毕"}`;
  }
  if (!/^\/forget(?:\s|$)/.test(text)) return undefined;
  const targetText = text.replace(/^\/forget\s*/, "").trim();
  return forgetMemory(log, options, input, text, { targetText, replyIntent: !targetText }, onStarted);
}

/** A memory operation consumes explicit target intent; Channels/adapters decide how it was requested. */
export async function forgetMemory(log: RuntimeLog, options: MemoryCommandOptions, input: CommandInput, text: string,
  targetIntent: { targetText: string; replyIntent: boolean }, onStarted?: () => void): Promise<string> {
  const events = await log.read();
  const originals = memoryNodes(events.filter((event) => event.type !== "memory_excluded"), input.ownerId);
  const receipt = { type: "input_received" as const, chatId: input.ownerId, messageId: input.messageId, intent: text,
    replyToMessageId: input.replyToMessageId, diagnosticInspection: false };
  const { targetText, replyIntent } = targetIntent;
  const explicit = originals.find((node) => node.id === targetText);
  const replied = input.replyToMessageId === undefined ? [] : memoryNodesForReply(events, input.ownerId, input.replyToMessageId);
  const target = explicit ?? (replyIntent && replied.length === 1 ? replied[0] : undefined);
  if (!target) {
    await appendRuntimeFact(log, receipt); onStarted?.();
    const candidates = originals.filter((node) => !memoryExclusions(events).has(node.id) &&
      (!targetText || node.messages.some((message) => message.text.includes(targetText)))).slice(-5);
    return `请确定要遗忘的旧轮次；回复目标消息发送 /forget，或使用 /forget 节点引用。当前没有执行排除。\n${candidates.map((node) => `${node.id}：${Array.from(node.messages[0]!.text).slice(0, 60).join("")}`).join("\n")}`;
  }
  const batch = memoryExclusions(events).has(target.id) ? [receipt] : [receipt, { type: "memory_excluded" as const, nodeId: target.id, userId: input.ownerId,
    messageId: input.messageId, replyToMessageId: input.replyToMessageId, intent: text }];
  await appendRuntimeFacts(log, batch);
  onStarted?.();
  try {
    options.purgeEmbeddingCache?.();
    await Promise.all([invalidateMemoryIndex(options.dataDir), createCheckpointStore(options.dataDir, "structured-text-v1", input.conversationId).invalidate()]);
  } catch { await appendRuntimeFact(log, { type: "memory_degraded", userId: input.ownerId, reason: "exclusion_cache_cleanup_unavailable" }).catch(() => undefined); }
  return "已排除该旧轮次的召回、学习和后续上下文。原始运行日志仍保留，可明确查阅；这不是数据删除。";
}
