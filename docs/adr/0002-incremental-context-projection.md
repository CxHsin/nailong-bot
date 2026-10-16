---
status: superseded
---

> 历史/离线说明：记录基准 d03422048b6a22502e8ac1952ae3d3a434612bc1 的旧实现与验收；2026-10-12 生产入口已由 [Personal Host](../personal-agent-operations.md) 取代。旧离线工具与数据实现已于 2026-10-17 按 [ADR-0014](0014-retire-legacy-code-and-data.md)退役；以下旧命令、在线行为和测试结果仅保留历史依据，不能作为新入口的验收证据。

# Reuse validated Context Projection snapshots

Conversation projections retain a disposable snapshot of raw source identity, completed replay units and verified tool results. The cache key includes Conversation, Provider model, protocol, prompt and tool configuration. Each query validates the append-only source prefix and replays from the earliest affected Run, retaining earlier units. Current-Run feedback is never carried into a later Run. Late delivery, result and discard events force their owning Run back into replay.

Reset, forgetting, source changes and incompatible or corrupt snapshots require reconstruction from original logs. Production Host replay now follows ADR-0004: tool visibility stays fixed across Runs, and a durable one-time activity boundary replaces recency selection. Before its retirement in #149, the legacy adapter used its old recent range and full reconstruction; recent-range interpretation remains for historical data, initialization and offline comparisons, as recorded in ADR-0003. Checkpoint summaries and raw archives remain separate. Cache writes are atomic and failures cannot block an answer.

This removes repeated projection and archive recovery, but does not yet eliminate full source reads and prefix hashing. Diagnostics distinguish replayProcessedEvents from raw source size. Cached tool content is an already verified derived copy; physical archive revalidation occurs on cache miss rather than every model step. Snapshot hashes detect corruption, not malicious modification.

Implementation and differential acceptance: #95.
