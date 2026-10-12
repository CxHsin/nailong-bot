import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PersonalHost } from './host.js';
import type { Delivery, PersonalInput } from './types.js';

/** Plain output with durable pages. A lost acknowledgement never authorizes a resend. */
export function createPlainChannel(options: {
  host: PersonalHost; accepts: (conversationId: string) => boolean; maxChars?: number;
  sendText(text: string, delivery: Delivery): Promise<string>;
  sendFile?(path: string, delivery: Delivery): Promise<string>;
  onDelivered?(delivery: Delivery): Promise<void>;
  reportFailure?(error: unknown): void;
}) {
  const { host } = options;
  const tails = new Map<string, Promise<void>>();
  let closed = false;
  const chars = options.maxChars ?? 3500;
  if (!Number.isSafeInteger(chars) || chars < 1) throw new Error('Invalid page size');
  function parts(parent: Delivery) {
    const old = host.store.listDeliveries(parent.conversationId).filter(d => d.parentId === parent.id);
    if (old.length) return old;
    const points = Array.from(parent.text);
    const pages: Delivery[] = [];
    for (let i = 0; i < points.length; i += chars) pages.push({ ...parent, id: `${parent.id}:text:${pages.length}`,
      parentId: parent.id, text: points.slice(i, i + chars).join(''), kind: 'text', artifacts: undefined, status: 'pending' });
    for (const [i, path] of (parent.artifacts ?? []).entries()) pages.push({ ...parent, id: `${parent.id}:file:${i}`,
      parentId: parent.id, kind: 'file', path, text: '', artifacts: undefined, status: 'pending' });
    host.store.transaction(() => { for (const page of pages) host.store.putDelivery(page); });
    return pages;
  }
  async function send(parentId: string) {
    const parent = host.delivery(parentId);
    if (!parent || parent.parentId || !options.accepts(parent.conversationId) || parent.status === 'unknown') return;
    if (parent.status === 'sent') { await learn(parent); return; }
    if (!host.beginDelivery(parent.id)) return;
    const pages = parts(parent);
    let firstMessageId: string | undefined;
    for (const page of pages) {
      let current = host.delivery(page.id)!;
      if (current.status === 'sent') { firstMessageId ??= current.providerMessageId; continue; }
      if (current.status === 'unknown' || current.status === 'sending') { host.recordDelivery(parent.id, 'unknown'); return; }
      for (let attempt = 0; attempt < 3; attempt++) {
        current = host.delivery(page.id)!;
        if ((current.attempts ?? 0) >= 3) { host.recordDelivery(parent.id, 'rejected'); return; }
        current.attempts = (current.attempts ?? 0) + 1; host.store.putDelivery(current);
        if (!host.beginDelivery(page.id)) break;
        let id: string;
        try {
          if (page.kind === 'file') {
            if (!options.sendFile) throw Object.assign(new Error('该 Channel 不支持文件交付'), { error_code: 400 });
            const expected = page.artifactDigests?.[page.path!];
            if (expected && createHash('sha256').update(await readFile(page.path!)).digest('hex') !== expected)
              throw Object.assign(new Error('成果文件已变化，拒绝发送未经验收的内容'), { error_code: 400 });
            id = await options.sendFile(page.path!, page);
          } else id = await options.sendText(page.text, page);
        } catch (error) {
          const code = (error as { error_code?: number }).error_code;
          const rejected = typeof code === 'number' && code >= 400 && code < 500;
          host.recordDelivery(page.id, rejected ? 'rejected' : 'unknown');
          if (!rejected || attempt === 2 || code !== 429) {
            host.recordDelivery(parent.id, rejected ? 'rejected' : 'unknown'); options.reportFailure?.(error); return;
          }
          const seconds = (error as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 1;
          if (seconds > 60) { host.recordDelivery(parent.id, 'rejected'); return; }
          await new Promise(resolve => setTimeout(resolve, Math.max(1, seconds) * 1000));
          continue;
        }
        // Persistence failure after a successful API call leaves 'sending'; never retry it.
        host.recordDelivery(page.id, 'sent', id); firstMessageId ??= id; break;
      }
      current = host.delivery(page.id)!;
      if (current.status !== 'sent') { host.recordDelivery(parent.id, current.status === 'unknown' || current.status === 'sending' ? 'unknown' : 'rejected'); return; }
    }
    host.recordDelivery(parent.id, 'sent', firstMessageId);
    await learn(host.delivery(parent.id)!);
  }
  async function learn(parent: Delivery) {
    if (parent.learningRecorded || !parent.learning || !options.onDelivered) return;
    await options.onDelivered(parent);
    const current = host.delivery(parent.id)!; current.learningRecorded = true; host.store.putDelivery(current);
  }
  function deliver(id: string) {
    const parent = host.delivery(id);
    if (!parent || closed) return Promise.resolve();
    const tail = tails.get(parent.conversationId) ?? Promise.resolve();
    const next = tail.catch(() => {}).then(() => send(id));
    tails.set(parent.conversationId, next);
    void next.catch(error => options.reportFailure?.(error));
    return next;
  }
  const unsubscribe = host.subscribe(delivery => { if (!delivery.parentId && options.accepts(delivery.conversationId)) void deliver(delivery.id); });
  return {
    receive: (input: PersonalInput) => host.submit(input), deliver,
    async flush() { while (true) { const current = [...tails.values()]; await Promise.allSettled(current); if (current.every((tail, i) => [...tails.values()][i] === tail)) return; } },
    async recover() { for (const delivery of host.store.listDeliveries()) if (!delivery.parentId && (delivery.status === 'pending' || delivery.status === 'sent' && delivery.learning && !delivery.learningRecorded)) await deliver(delivery.id); },
    async close() { unsubscribe(); await Promise.allSettled([...tails.values()]); closed = true; },
  };
}

export function cliInput(text: string, conversationId: string, actorId: string): PersonalInput {
  return { text, conversationId, actorId, inputId: randomUUID() };
}
