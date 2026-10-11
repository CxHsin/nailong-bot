import { randomUUID } from "node:crypto";
import type { RuntimeLog, StoredEvent } from "../runtime/runtime-types.js";
import { pendingActiveContext, type ActiveContextStart, type LegacyContextScope } from "../runtime/history-scope.js";

export { resetIdentity, activeContextStart, activeRequestIds, type ActiveContextStart } from "../runtime/history-scope.js";

/** The online caller owns source reads and migration identity, not fact interpretation. */
export async function prepareActiveContext(log: RuntimeLog, currentId: string,
  legacy?: LegacyContextScope): Promise<{ raw: StoredEvent[]; pending?: ActiveContextStart }> {
  const raw = await log.read();
  return { raw, pending: pendingActiveContext(raw, currentId, randomUUID(), legacy) };
}
