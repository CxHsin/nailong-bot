---
status: accepted
---

# Use Provider-aware context projection

Nailong Bot will keep durable runtime history, live channel progress, and model input as separate projections. The Host will build an intermediate context-item union, while each Provider adapter decides which items and reasoning continuation metadata can be replayed, how prompt-cache identity and stable prefixes are maintained, and when compaction replaces an old prefix with a summary. UI-only activity, drafts, and delivery facts will not enter model context. Following #82/#83, settled assistant progress and valid read-only progress-model summaries are ordinary replayable text with recorded provenance; they are not Provider reasoning continuation or Akasha memory content. This preserves Provider-specific reasoning contracts and prompt-cache stability instead of flattening every event into user/tool/assistant text.

## Consequences

- Provider capabilities and replay policy become explicit dependencies of Context Projection.
- Original runtime records remain available for recovery and re-projection, while compaction may replace only the active model prefix.
- Tests must verify stable cache keys/prefixes and filtering of UI-only events, not only final answer text.
- Timeline delivery selects committed text units. Settlement, Run completion and Channel delivery remain separate facts; replay does not resend history.
- Akasha admits confirmed user/assistant answer content, excludes progress-model summaries and process explanations, and preserves historical result provenance during migration.
