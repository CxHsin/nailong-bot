---
status: accepted
---

# Reuse validated Context Projection snapshots

Conversation projections retain a disposable snapshot of raw source identity, completed replay units and verified tool results. The cache key includes Conversation, Provider model, protocol, prompt and tool configuration. Each query validates the append-only source prefix and replays from the earliest affected Run, retaining earlier units. Current-Run feedback is never carried into a later Run. Late delivery, result and discard events force their owning Run back into replay.

Reset, forgetting, source changes and incompatible or corrupt snapshots require reconstruction from original logs. Legacy replay retains full reconstruction because recency changes tool visibility. Checkpoint summaries and raw archives remain separate. Cache writes are atomic and failures cannot block an answer.

This removes repeated projection and archive recovery, but does not yet eliminate full source reads and prefix hashing. Diagnostics distinguish replayProcessedEvents from raw source size. Cached tool content is an already verified derived copy; physical archive revalidation occurs on cache miss rather than every model step. Snapshot hashes detect corruption, not malicious modification.

Implementation and differential acceptance: #95.
