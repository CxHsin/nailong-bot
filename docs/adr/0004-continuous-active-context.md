---
status: proposed
---

# Preserve continuous active context across runs and restarts

The personal Agent uses one continuing Conversation. The three-prior-turn policy in ADR-0003 shifts the input prefix every Run, and restoring complete historical tool results changes previously sent content. We have agreed to replace this with an active Context Projection that appends ordinary turns, reuses recorded tool-result views across Runs, and restores the same active context after a process restart. Runtime Event Log and full tool archives remain the sources for reconstruction and precise recovery.

An input budget applies throughout execution. Reaching a threshold triggers batch compaction of an explicitly covered prefix, retaining a summary and recent originals with enough headroom for further turns. A validated projection snapshot and compaction boundary support restart recovery; missing or invalid derived state is rebuilt from the original facts. Small tool results may remain complete, while large results use a recorded bounded view; explicit reads append recovered details. Reset, forgetting and Provider replay requirements still govern correctness.

Compaction must retain effective user constraints, unfinished work, key decisions, continuation state and evidence references, alongside recent originals. Details of completed topics may leave active context and remain recoverable from the log or Akasha. Akasha continues automatic question-related retrieval, appending relevant original fragments not already fully represented in active context; explicit search and read remain available. Lossy summary coverage must not block recovery of the originals it covers. Exact and partial original coverage therefore need to remain distinct from summary coverage.

These directions were confirmed during the 2026-10-10 design discussion. Budget values, initial transition from the existing policy and compaction failure handling remain open. This proposal does not yet supersede ADR-0003 or change runtime behavior; the complete design and implementation acceptance are pending. Supporting evidence: [long-conversation research](../research/long-conversation-prompt-cache-2026-10-10.md).

## Consequences

- A restart restores continuity rather than selecting three prior turns. Snapshot reuse reduces projection work, but model input size still requires budgeting; full-log reads and hashing need separate performance verification.
- Compaction intentionally changes the covered prefix. Keep the accepted replacement stable until the next necessary compaction, and evaluate its cost alongside steady-state reuse and idle-time cache expiry.
- A recorded bounded tool view remains bounded when its Run becomes historical. This reopens ADR-0003's full-result replay decision without removing the original archive.
