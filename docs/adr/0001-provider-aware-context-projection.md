---
status: accepted
---

# Use Provider-aware context projection

Nailong Bot will keep durable runtime history, live channel progress, and model input as separate projections. The Host will build an intermediate context-item union, while each Provider adapter decides which items and reasoning continuation metadata can be replayed, how prompt-cache identity and stable prefixes are maintained, and when compaction replaces an old prefix with a summary. UI-only progress, drafts, and delivery facts will not enter model context by default. This preserves Provider-specific reasoning contracts and prompt-cache stability instead of flattening every event into user/tool/assistant text.

## Consequences

- Provider capabilities and replay policy become explicit dependencies of Context Projection.
- Original runtime records remain available for recovery and re-projection, while compaction may replace only the active model prefix.
- Tests must verify stable cache keys/prefixes and filtering of UI-only events, not only final answer text.
