import { randomUUID } from "node:crypto";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { RuntimeLog, StoredEvent } from "../runtime/runtime-types.js";
import { historyScope, pendingActiveContext } from "../runtime/history-scope.js";
import { encodeHistory } from "../agent/history-codec.js";

/** Historical initialization chooses its own causal prefix; it has no Projection cache or checkpoint. */
export async function historicalMemoryContext(log: Pick<RuntimeLog, "append" | "recoverArchive" | "isArchiveRead">,
  source: StoredEvent[], currentId: string, model: Model<Api>) {
  const pending = pendingActiveContext(source, currentId, randomUUID());
  const scope = historyScope(source, currentId, pending);
  const encoded = await encodeHistory(scope, currentId, model, true, log);
  // Preserve the historical caller's existing pending-start append until #151 is
  // separately approved. Its synthetic-prefix corruption is not fixed by #148.
  if (pending) await log.append(pending);
  return encoded;
}
