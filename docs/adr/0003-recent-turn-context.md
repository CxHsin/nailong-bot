---
status: superseded
---

> 历史/离线说明：记录基准 d03422048b6a22502e8ac1952ae3d3a434612bc1 的旧实现与验收；2026-10-12 生产入口已由 [Personal Host](../personal-agent-operations.md) 取代。旧离线工具与数据实现已于 2026-10-17 按 [ADR-0014](0014-retire-legacy-code-and-data.md)退役；以下旧命令、在线行为和测试结果仅保留历史依据，不能作为新入口的验收证据。

# Restore three recent turns for the personal Agent

Superseded for production Host by [ADR-0004](0004-continuous-active-context.md). The legacy createApp adapter was retired in #149 after auditing callers and migrating useful regression coverage. Recent-range interpretation remains for historical data, initialization and offline comparisons; the text below records the previous production policy, not a current execution entry.

Context Projection selects the latest three prior user turns and the current turn from the Conversation's runtime event log before recovering tool archives. A turn includes the original user input, replayable settled assistant text and paired tool calls/results. Historical tool results are recovered in full; the current Run retains its existing bounded live tool views. UI-only activity, delivery receipts and unfinished drafts remain outside model context.

Older runtime records remain durable and available to Akasha's question-related memory retrieval. They are not automatically replayed or summarized into the active input. Fixed configuration and the current memory snapshot continue to enter through their existing paths. This favors bounded recent conversation over a coding Agent's continuously accumulated task context. Explicit recovery of unfinished tasks is deferred.

## Consequences

- This narrows the history scope of ADR-0001 while retaining Provider-specific protocol and reasoning rules, reset isolation and forgetting filters.
- ADR-0002's incremental cache remains disposable. Cached active tool views must be rebuilt as full historical results when the current Run changes, and expired turns must leave the replay units.
- Checkpoint identity includes the selected prior turns. Full-history checkpoints and summaries containing expired turns cannot re-enter the input.
- When selected messages themselves exceed the model budget, safe compaction may summarize only that selected scope. Current input and tool pairing protections remain in force; three turns are not a token limit.
- Window movement may require a new local summary instead of reusing the previous one. Full recent tool results may still be large.
- Source reads and identity validation may still inspect the full log; unrelated older tool archives are not recovered.

Confirmed scope and acceptance: #100. Earlier small-batch compaction fix: #99.
