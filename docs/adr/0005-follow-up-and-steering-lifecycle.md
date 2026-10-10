---
status: accepted
---

# Separate follow-up Runs from active steering

Ordinary inputs received during active work are Follow-ups: after the active Run succeeds, process each input in receipt order as a separate Run in the same Conversation. Explicit `/steer` inputs belong to the active Run and are presented together in receipt order after its current batch of tools completes. An entirely idle Conversation treats `/steer` content as ordinary input. Telegram and CLI share these semantics.

Pi supports both steering and follow-up queues inside one session. We keep user Follow-ups as separate Runs so that each subsequent input has an explicit execution outcome rather than extending the original Run indefinitely. Steer retains the identity of the work it modifies. Pi's runtime protocol feedback is distinct from a user Follow-up and must retain its own purpose.

`/stop` stops active work and cancels pending user inputs in the same Conversation; it does not roll back completed actions. If the active Run fails, cancel its Conversation's pending inputs and tell the user. After a process restart, retain interrupted and pending input records and notify the user to resubmit; do not automatically execute them.

Stop establishes an input boundary: cancel pending inputs accepted before it, including queued control commands, while later inputs wait for the stopped Run to exit before starting new work. Already executed settings remain effective, and read-only diagnostics remain available. When the Conversation has queued inputs but no active Run, `/steer` content becomes ordinary input at the queue tail, just as it becomes ordinary input when entirely idle. There is no separate `/followup` command.

Already completed work and applied steering remain context facts, with an explicit indication that stopped work must not automatically resume. Cancelled inputs that were never consumed remain audit records and do not enter model context. These rules preserve the completed facts and continuing Conversation required by [ADR-0004](0004-continuous-active-context.md), while distinguishing effective user instructions from inputs cancelled before use.

Confirmed during the 2026-10-10 grill-with-docs discussion. This records accepted design decisions; the user control entry points and queue lifecycle are not yet implemented. Receipts distinguish queued inputs, steering waiting for a tool boundary versus applied steering, and a stop request versus completed cancellation. Rich inputs, CLI interrupts and cross-process control scope remain under discussion.
