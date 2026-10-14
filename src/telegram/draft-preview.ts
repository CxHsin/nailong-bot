import { randomInt } from 'node:crypto';
export type ReplyPreview = { conversationId: string; replyId: string; text?: string };

/** A single coalescing, best-effort draft lane. stop() is a barrier before durable send. */
export function createDraftPreview(options: {
  send(draftId: number, text: string): Promise<unknown>;
  reportFailure(error: unknown): void;
  intervalMs?: number;
}) {
  let active: { replyId: string; draftId: number; text: string; sent?: string; stopped: boolean } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | undefined;
  let nextAt = 0;
  let closed = false;
  let paused = 0;
  const interval = options.intervalMs ?? 1000;
  const report = (error: unknown) => { try { options.reportFailure(error); } catch { /* reporting cannot break delivery */ } };
  const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
  function schedule() {
    if (closed || paused || timer || flight || !active || active.stopped || !active.text || active.text === active.sent) return;
    timer = setTimeout(() => { timer = undefined; void send(); }, Math.max(0, nextAt - Date.now()));
  }
  async function send() {
    const current = active;
    if (!current || current.stopped || closed) return;
    const text = current.text;
    nextAt = Date.now() + interval;
    flight = (async () => {
      try { await options.send(current.draftId, text); current.sent = text; }
      catch (error) {
        const failure = error as { error_code?: number; parameters?: { retry_after?: number } };
        if (failure.error_code === 429) {
          const seconds = failure.parameters?.retry_after;
          nextAt = Date.now() + (typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(1, seconds) : 1) * 1000;
        } else current.stopped = true;
        report(error);
      }
    })();
    await flight; flight = undefined; schedule();
  }
  return {
    update(preview: ReplyPreview) {
      if (closed) return;
      if (preview.text === undefined) { if (active?.replyId === preview.replyId) { active.stopped = true; clear(); } return; }
      if (active?.replyId !== preview.replyId) { clear(); if (active) active.stopped = true; active = { replyId: preview.replyId, draftId: randomInt(1, 2 ** 31), text: '', stopped: false }; }
      if (active.stopped) return;
      active.text = preview.text;
      schedule();
    },
    async stop() { if (active) active.stopped = true; clear(); await flight; },
    async withoutDrafts<T>(action: () => Promise<T>): Promise<T> {
      paused++; if (active) active.stopped = true; clear();
      try { await flight; return await action(); } finally { paused--; schedule(); }
    },
    async close() { closed = true; if (active) active.stopped = true; clear(); await flight; },
  };
}
