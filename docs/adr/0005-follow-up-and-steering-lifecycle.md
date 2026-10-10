---
status: accepted
---

# Separate follow-up Runs from active steering

Ordinary inputs received during active work are Follow-ups: after the active Run succeeds, process each input in receipt order as a separate Run in the same Conversation. Explicit `/steer` inputs belong to the active Run and are presented together in receipt order after its current batch of tools completes. An entirely idle Conversation treats `/steer` content as ordinary input. Telegram and CLI share these semantics.

Pi supports both steering and follow-up queues inside one session. We keep user Follow-ups as separate Runs so that each subsequent input has an explicit execution outcome rather than extending the original Run indefinitely. Steer retains the identity of the work it modifies. Pi's runtime protocol feedback is distinct from a user Follow-up and must retain its own purpose.

`/stop` stops active work and cancels pending user inputs in the same Conversation; it does not roll back completed actions. If the active Run fails, cancel its Conversation's pending inputs and tell the user. After a process restart, retain interrupted and pending input records and notify the user to resubmit; do not automatically execute them.

Already completed work and applied steering remain context facts, with an explicit indication that stopped work must not automatically resume. Cancelled inputs that were never consumed remain audit records and do not enter model context. These rules preserve the completed facts and continuing Conversation required by [ADR-0004](0004-continuous-active-context.md), while distinguishing effective user instructions from inputs cancelled before use.

Confirmed during the 2026-10-10 grill-with-docs discussion. This records accepted design decisions; the user control entry points and queue lifecycle are not yet implemented. Command details, receipt feedback and concurrent control behavior remain under discussion.
