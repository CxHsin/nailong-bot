import { memoryNodes, memoryExclusions, memoryNodesForReply } from "../runtime/memory-facts.js";
import { invalidateMemoryIndex } from "../memory/cache.js";
import { createCheckpointStore } from "../context/checkpoint.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import type { Update } from "./app-types.js";

export async function handleMemoryCommand(log: RuntimeLog, options: { dataDir: string; conversationId?: string; purgeEmbeddingCache?: () => void;
  send: (text: string, update: Update) => Promise<void> }, update: Update, text: string, onStarted?: () => void): Promise<boolean> {
  if (update.images?.length) return false;
  const raw = /^\/memory\s+log\s+(\S+)(?:\s+(\d+))?$/.exec(text);
  const command = /^\/forget(?:\s|$)/.test(text);
  const natural = /^(?:请)?(?:帮我)?(?:忘掉|忘记|不要再记得)/.test(text) && !/[?？]|怎么办|如何|怎么|为什么|是否|能否|吗/.test(text);
  const forget = command || natural;
  if (!raw && !forget) return false;
  const events = await log.read();
  const originals = memoryNodes(events.filter((event) => event.type !== "memory_excluded"), update.userId);
  const receipt = { type: "input_received", chatId: update.userId, messageId: update.messageId, intent: text,
    replyToMessageId: update.replyToMessageId, diagnosticInspection: !!raw };
  if (raw) {
    await log.append(receipt); onStarted?.();
    const node = originals.find((item) => item.id === raw[1]);
    if (!node) { await options.send("没有找到该原始轮次。", update); return true; }
    const offset = Number(raw[2] ?? 0);
    if (!Number.isSafeInteger(offset)) { await options.send("原始日志读取位置无效。", update); return true; }
    const body = node.messages.map((message) => `[${message.role} ${message.at} ${message.id}]\n${message.text}`).join("\n");
    const points = Array.from(body); const end = Math.min(points.length, offset + 1800);
    await options.send(`原始日志诊断查阅，不恢复记忆、不参与强化：\n${points.slice(offset, end).join("")}\n${end < points.length ? `续读：/memory log ${node.id} ${end}` : "读取完毕"}`, update);
    return true;
  }
  const targetText = text.replace(/^\/forget\s*|^(?:请)?(?:帮我)?(?:忘掉|忘记|不要再记得)\s*/, "").trim();
  const explicit = originals.find((node) => node.id === targetText);
  const replied = update.replyToMessageId === undefined ? [] : memoryNodesForReply(events, update.userId, update.replyToMessageId);
  const replyIntent = command && !targetText || /^(?:请)?(?:帮我)?(?:忘掉|忘记|不要再记得)(?:这件事|这条消息|这个轮次|这一轮|这个)[。！!]?$/u.test(text);
  const target = explicit ?? (replyIntent && replied.length === 1 ? replied[0] : undefined);
  if (!target) {
    await log.append(receipt); onStarted?.();
    const candidates = originals.filter((node) => !memoryExclusions(events).has(node.id) &&
      (!targetText || node.messages.some((message) => message.text.includes(targetText)))).slice(-5);
    await options.send(`请确定要遗忘的旧轮次；回复目标消息发送 /forget，或使用 /forget 节点引用。当前没有执行排除。\n${candidates.map((node) => `${node.id}：${Array.from(node.messages[0]!.text).slice(0, 60).join("")}`).join("\n")}`, update);
    return true;
  }
  const batch = memoryExclusions(events).has(target.id) ? [receipt] : [receipt, { type: "memory_excluded", nodeId: target.id, userId: update.userId,
    messageId: update.messageId, replyToMessageId: update.replyToMessageId, intent: text }];
  if (log.appendBatch) await log.appendBatch(batch); else for (const event of batch) await log.append(event);
  onStarted?.();
  try {
    options.purgeEmbeddingCache?.();
    await Promise.all([invalidateMemoryIndex(options.dataDir), createCheckpointStore(options.dataDir, "structured-text-v1", options.conversationId).invalidate()]);
  } catch { await log.append({ type: "memory_degraded", userId: update.userId, reason: "exclusion_cache_cleanup_unavailable" }).catch(() => undefined); }
  await options.send("已排除该旧轮次的召回、学习和后续上下文。原始运行日志仍保留，可明确查阅；这不是数据删除。", update);
  return true;
}
