---
status: accepted
---

# Separate follow-up Runs from active steering

Ordinary inputs received during active work are Follow-ups: after the active Run succeeds, process each input in receipt order as a separate Run in the same Conversation. Explicit `/steer` inputs belong to the active Run and are presented together in receipt order after its current batch of tools completes. An entirely idle Conversation treats `/steer` content as ordinary input. Telegram and CLI share these semantics.

Pi supports both steering and follow-up queues inside one session. We keep user Follow-ups as separate Runs so that each subsequent input has an explicit execution outcome rather than extending the original Run indefinitely. Steer retains the identity of the work it modifies. Pi's runtime protocol feedback is distinct from a user Follow-up and must retain its own purpose.

`/stop` stops active work and cancels pending user inputs in the same Conversation; it does not roll back completed actions. If the active Run fails, cancel its Conversation's pending inputs and tell the user. After a process restart, retain interrupted and pending input records and notify the user to resubmit; do not automatically execute them.

Stop establishes an input boundary: cancel pending inputs accepted before it, including queued control commands, while later inputs wait for the stopped Run to exit before starting new work. Already executed settings remain effective, and read-only diagnostics remain available. When the Conversation has queued inputs but no active Run, `/steer` content becomes ordinary input at the queue tail, just as it becomes ordinary input when entirely idle. There is no separate `/followup` command.

Already completed work and applied steering remain context facts, with an explicit indication that stopped work must not automatically resume. Cancelled inputs that were never consumed remain audit records and do not enter model context. These rules preserve the completed facts and continuing Conversation required by [ADR-0004](0004-continuous-active-context.md), while distinguishing effective user instructions from inputs cancelled before use.

Follow-ups and Steers support images and existing explicit skill references using each Channel's established input format. Invalid inputs receive an error without failing active work. Receipts distinguish queued inputs, steering waiting for a tool boundary versus applied steering, and a stop request versus completed cancellation with the number of cancelled inputs. In interactive CLI, Ctrl+C stops active work while keeping the session open; when idle, it exits.

For this scope, each Channel controls its own Host rather than introducing cross-process control. Only one Host may operate a data directory; another must be rejected before startup recovery can mistake that Host's active Runs for interrupted work. On restart, the starting Channel summarizes recovery items and asks the user to resubmit: Telegram sends one summary message and CLI prints a summary. There is no notice without recovery items, and recovery does not automatically execute pending inputs.

Confirmed during the four-round 2026-10-10 grill-with-docs discussion: [#135](https://github.com/CxHsin/nailong-bot/issues/135). Specification [#136](https://github.com/CxHsin/nailong-bot/issues/136) is implemented by [#137](https://github.com/CxHsin/nailong-bot/issues/137): the production Host owns accepted inputs and controls, the real Agent applies Steers at complete step boundaries, and both Channels project durable receipts. A successful Provider HTTP response confirms application; prepared inputs without that confirmation remain audit-only after cancellation or failure. Multiple applied user messages belong to one Akasha Run node. The active Skill reader registers each Steer's frozen body and selected paths, preserving relative resource lookup and the accepted version when reading SKILL.md again.

Host ownership uses an OS-backed SQLite transaction lock on the canonical data directory, acquired before state initialization. Process death releases it without a lease timeout or PID guessing. Recovery records and notifications have separate durable identities; known rejection can retry, while delivery with an unknown result does not replay old tasks or notices. Compaction records instructions retained outside its covered prefix, so changing the current Run or rebuilding a projection cannot lose those instructions; explicit terminal state remains visible beyond a summary boundary.

Automated acceptance uses real Telegram/CLI adapters, Host and Agent with a local HTTP Provider and external tool barriers; real child processes verify ownership and recovery. Windows terminal acceptance verifies running Ctrl+C, subsequent input, and idle Ctrl+C. See [input-control acceptance](../input-controls-acceptance.md). Production deployment and restart are separate from implementation.
