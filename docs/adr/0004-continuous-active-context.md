---
status: accepted
---

# Preserve continuous active context across runs and restarts

The personal Agent uses one continuing Conversation. The three-prior-turn policy in ADR-0003 shifts the input prefix every Run, and restoring complete historical tool results changes previously sent content. We have agreed to replace this with an active Context Projection that appends ordinary turns, reuses recorded tool-result views across Runs, and restores the same active context after a process restart. Runtime Event Log and full tool archives remain the sources for reconstruction and precise recovery.

An input budget applies throughout execution. Reaching a threshold triggers batch compaction of an explicitly covered prefix, retaining a summary and recent originals with enough headroom for further turns. A validated projection snapshot and compaction boundary support restart recovery; missing or invalid derived state is rebuilt from the original facts. Small tool results may remain complete, while large results use a recorded bounded view; explicit reads append recovered details. Reset, forgetting and Provider replay requirements still govern correctness.

Compaction must retain effective user constraints, unfinished work, key decisions, continuation state and evidence references, alongside recent originals. Details of completed topics may leave active context and remain recoverable from the log or Akasha. Akasha continues automatic question-related retrieval, appending relevant original fragments not already fully represented in active context; explicit search and read remain available. Lossy summary coverage must not block recovery of the originals it covers. Exact and partial original coverage therefore need to remain distinct from summary coverage.

At the initial transition, continue from the last valid active context, including its settled answer, instead of loading all older history. This is a one-time migration boundary, retained during subsequent reconstruction. Runtime Event Log and Akasha continue to provide access to earlier facts.

Failed or ineffective compaction preserves the original context and checkpoint. Continue with a recorded degraded state only when the complete input still fits the hard budget; otherwise fail explicitly. Bound retries for the same compaction boundary, preserve completed tool outcomes and avoid clearing the Conversation as a recovery action.

These directions were confirmed during the 2026-10-10 design discussion. Initial configurable watermarks are delegated to read-only replay measurements; count fixed prompts, tools, memory and output headroom as well as conversation history. This design is implemented for the production Host path by #127 and its linked tasks. Deployment is separate: an already running process keeps its loaded version until the owner explicitly deploys/restarts it. ADR-0003 records the previous policy and remains applicable to the retained legacy adapter. Supporting evidence: [long-conversation research](../research/long-conversation-prompt-cache-2026-10-10.md).

Confirmed conclusion: [#125](https://github.com/CxHsin/nailong-bot/issues/125). Initial candidates are a trigger at 70% and a target at 40% of the effective hard input budget, a recent-original allowance of 20,000 tokens and a summary ceiling of 4,000 tokens. Fit the complete request within budget; these allowances are not unconditional retention guarantees. The recorded four-turn replay supports a conservative starting point, not optimal watermarks or measured continuous-context performance; see the research note's offline measurement section.

## Consequences

- A restart restores continuity rather than selecting three prior turns. Snapshot reuse reduces projection work, but model input size still requires budgeting; full-log reads and hashing need separate performance verification.
- Compaction intentionally changes the covered prefix. Keep the accepted replacement stable until the next necessary compaction, and evaluate its cost alongside steady-state reuse and idle-time cache expiry.
- A recorded bounded tool view remains bounded when its Run becomes historical. This reopens ADR-0003's full-result replay decision without removing the original archive.

## Implementation and verification

The one-time active_context_started fact fixes the migration scope; valid legacy snapshots contribute their selected scope, otherwise the previous Run scope is reconstructed once. Recorded tool projections contain model-visible bytes and source digests. Accepted context_checkpoint_committed facts retain frozen summaries independently of derived files. Coverage distinguishes actual original message/ranges from lossy summary involvement. Default configurable watermarks are 70%/40%, with bounded two-attempt operations and identical-input failure protection. When invalidation unfolds more source than one summary request can hold, two legal batches share that same two-call limit; the intermediate replacement remains uncommitted until the final candidate meets the target. Complete input budgeting counts configured output headroom.

Acceptance uses Telegram input → Host → real Agent → local simulated Provider, actual encoded requests and persistent facts, plus incremental/full rebuild comparisons. Tests cover beyond-three-turn continuity, corruption/restart, multiple compactions, task constraints, tool pairing, memory deduplication/precision recovery, forgetting, Skill versions and model switches. These tests do not establish remote KV TTL, real cache hit rate, cost or latency; production restart/deployment requires separate authorization.
