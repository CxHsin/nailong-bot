import type { RuntimeLog, StoredEvent } from "./runtime-types.js";

/** Read a fresh committed prefix while decoding each SQLite event only once per view. */
export function createEventReader(log: RuntimeLog): () => Promise<StoredEvent[]> {
  if (!log.readSince) return () => log.read();
  const events: StoredEvent[] = [];
  let cursor = 0;
  let queue = Promise.resolve();
  return () => {
    const next = queue.then(async () => {
      const additions = await log.readSince!(cursor);
      if (additions.length) {
        events.push(...additions);
        cursor = Number(additions.at(-1)!.sequence);
      }
      // Readers retain their own prefix even when later reads observe newly committed events.
      return events.slice();
    });
    queue = next.then(() => {}, () => {});
    return next;
  };
}
