import { randomUUID } from "node:crypto";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { RuntimeLog, StoredEvent } from "../runtime/runtime-types.js";
import { historyScope, pendingActiveContext } from "../runtime/history-scope.js";
import { encodeHistory } from "../agent/history-codec.js";

/** Historical initialization chooses its own causal prefix; it has no Projection cache or checkpoint. */
export async function historicalMemoryContext(archives: Pick<RuntimeLog, "recoverArchive" | "isArchiveRead">,
  source: StoredEvent[], currentId: string, model: Model<Api>) {
  // The synthetic prefix needs its own scope, but cannot establish a durable online boundary.
  const pending = pendingActiveContext(source, currentId, randomUUID());
  const scope = historyScope(source, currentId, pending);
  return encodeHistory(scope, currentId, model, true, archives);
}
