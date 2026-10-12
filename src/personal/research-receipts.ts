import { createHash, randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { Task, TaskResult, WorkToolContext, ActionDispatch } from './types.js';
import { requirePermission, permissionError } from './permissions.js';

export interface RetrievalAdapter { provider: string; version: string; validateArgs(args: Record<string, unknown>): void; extract(args: Record<string, unknown>, result: unknown): Array<{ url: string; payload: string }> }
interface RetrievalReceipt { id: string; version: 1; provider: string; adapterVersion: string; url: string; payload: string; sha256: string; at: number; rootTaskId: string; actorId: string; conversationId: string }
const hash = (payload: string) => createHash('sha256').update(payload).digest('hex');
export function sourceUrl(raw: string): string { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw permissionError('检索只接受无凭据的 HTTP(S) 来源 URL'); return url.href; }

/** Only explicitly registered retrieval adapters can produce these ledger records.
 * A model's result details or a generated workspace file is not provenance. */
export function controlledRetrievalTool(entry: { tool: ToolDefinition; retrieval: RetrievalAdapter }, getWork: () => WorkToolContext): ToolDefinition {
  const { tool, retrieval } = entry;
  return { ...tool, async execute(...args: Parameters<ToolDefinition['execute']>) {
    const work = getWork(); const current = work.current();
    if (!requirePermission(current).network) throw permissionError('检索网络尚未授权；未派发');
    retrieval.validateArgs(args[1] as Record<string, unknown>);
    return work.dispatch(args[0], { kind: 'research-retrieval', target: retrieval.provider, parameters: { tool: tool.name, adapterVersion: retrieval.version, arguments: args[1] }, content: 'Retrieve provider-returned original content' }, async () => {
      const task = work.current(); if (!requirePermission(task).network) throw permissionError('检索网络授权已变化；未派发');
      const result = await tool.execute(...args);
      const researchReceipts: RetrievalReceipt[] = retrieval.extract(args[1] as Record<string, unknown>, result).map(source => {
        if (!source.payload?.trim()) throw new Error('检索未返回可核对的实际内容');
        return { id: randomUUID(), version: 1, provider: retrieval.provider, adapterVersion: retrieval.version, url: sourceUrl(source.url), payload: source.payload, sha256: hash(source.payload), at: Date.now(), rootTaskId: task.rootTaskId ?? task.id, actorId: task.actorId, conversationId: task.conversationId };
      });
      if (!researchReceipts.length) throw new Error('检索没有来源回执');
      return { ...result, content: [...result.content, { type: 'text' as const, text: JSON.stringify({ sourceReceipts: researchReceipts.map(({ payload: _payload, ...receipt }) => receipt), note: 'Provider-returned content; not independently corroborated.' }) }], details: { researchReceipts } };
    });
  } } as ToolDefinition;
}

export function resolveRemoteSource(task: Task, source: NonNullable<TaskResult['sources']>[number], actions: ActionDispatch[]): NonNullable<TaskResult['sources']>[number] {
  if (!source.receiptId) throw new Error('远端来源缺少受控检索回执');
  for (const action of actions) {
    if (action.status !== 'succeeded' || action.action.kind !== 'research-retrieval' || !action.evidence) continue;
    let receipts: RetrievalReceipt[]; try { receipts = JSON.parse(action.evidence).details?.researchReceipts ?? []; } catch { continue; }
    const receipt = receipts.find(item => item.id === source.receiptId); if (!receipt) continue;
    if (receipt.version !== 1 || receipt.rootTaskId !== (task.rootTaskId ?? task.id) || receipt.actorId !== task.actorId || receipt.conversationId !== task.conversationId || receipt.provider !== action.action.target || receipt.adapterVersion !== action.action.parameters.adapterVersion || hash(receipt.payload) !== receipt.sha256 || receipt.url !== sourceUrl(source.reference) || !source.excerpt.trim() || !receipt.payload.includes(source.excerpt) || !source.supports?.some(claim => claim.trim())) throw new Error('远端来源回执、范围、URL 或原文摘录失配');
    return { ...source, reference: receipt.url, provider: receipt.provider, kind: 'remote' };
  }
  throw new Error('没有属于本工作的成功检索回执');
}
