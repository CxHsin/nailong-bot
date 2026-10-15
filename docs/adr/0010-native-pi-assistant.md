---
status: accepted
---

# Native Pi main assistant with herdr skill

2026-10-14 confirmed direction [#195](https://github.com/CxHsin/nailong-bot/issues/195), specification [#196](https://github.com/CxHsin/nailong-bot/issues/196), implementation [#197](https://github.com/CxHsin/nailong-bot/issues/197).

2026-10-15: [ADR-0011](0011-durable-main-agent-and-conversation-queue.md) replaces the direction of deferring main-agent durable execution and relying on native steering for incoming input. The production entry still follows the implementation below until that migration is completed; its evidence does not establish the new queue or recovery guarantees.

## Decision

Use one native Pi main Session per conversation. Pi owns the agent loop, tools, resource discovery, steering and compaction. The local service connects authenticated Telegram/CLI input and output. It keeps a process lock, conversation/session pointers, deduplication and versioned minimal helper observation records.

Coding uses herdr-workflow through native Shell, with Codex and Claude configuration inherited from the existing CLI. `herdr_watch` observes only an already dispatched helper after receipt confirmation. Background observation returns materials through Pi's supported custom-message interface, serialized with user acceptance. The main assistant inspects actual artifacts; idle/done is not acceptance.

Local execution trusts the starting account's authority. User and project instructions still control action scope. Remove the online Host's `work_permission`, `submit_material`, `verify_result`, `complete_work`, Task/Attempt settlement and custom provider discovery adapters. Ordinary tool errors go back to Pi. This replaces ADR-0008/0009's online permission, acceptance and work-context protocol; those ADRs retain historical evidence.

Use a fresh `data/pi-assistant-v1` namespace. Old sessions, Akasha, plans, working agreements and Task records are neither read nor migrated. Switching does not delete old files. Timers, proactive duties, server deployment and multiple bots are deferred.

## Recovery and limits

A conversation points to the selected native Session, including a reset whose JSONL has not yet been written. Known conversations load at startup; helper observation resumes when an output channel attaches. Reconcile actual helper identity and state, never blindly relaunch. Native custom-message receipts prevent known results from being injected again; queued follow-ups without a receipt are reconsidered after restart. `/reset` preserves helper records and does not terminate external work.

Input acceptance is deduplicated before model execution. A crash after acceptance can lose unfinished work; there is no promise of automatically completing every accepted input, cross-system exactly-once, or rollback of external effects. Telegram unknown outcomes are recorded without automatic retry. Main assistants must independently inspect returned materials and follow target-project requirements.

## Implementation and evidence

Formal entries: [Telegram](../../src/main.ts), [CLI](../../src/cli/main.ts); service [runtime](../../src/assistant/runtime.ts), [bridge](../../src/assistant/herdr.ts), [channel](../../src/assistant/telegram.ts). Retired online Host code and protocol-specific tests are removed; offline historical diagnostics remain separate. See [current acceptance](../pi-assistant-acceptance-20261014.md) for actual test results and real-model limitations, and [operations](../personal-agent-operations.md) for setup.
