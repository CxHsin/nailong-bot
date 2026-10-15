# Nailong Bot Agent Context

One personal assistant uses native Pi through Telegram or CLI. Current production baseline: [ADR-0010](docs/adr/0010-native-pi-assistant.md), [spec #196](https://github.com/CxHsin/nailong-bot/issues/196). Accepted next direction: [ADR-0011](docs/adr/0011-durable-main-agent-and-conversation-queue.md), [conclusion #200](https://github.com/CxHsin/nailong-bot/issues/200), [spec #201](https://github.com/CxHsin/nailong-bot/issues/201); implementation tasks #202–#205 and migration are pending. Older Host terminology below has been retired from the online path; historical ADRs keep their original evidence.

## Language

**Personal Agent**: The main assistant for ongoing conversation and work. Coding is one capability, delegated through the project herdr-workflow skill when appropriate.

**Session**: Pi-native model exchanges, tools, compaction and steering. A completed model turn does not prove the user's goal or an external process has completed.

**Assistant Service**: Thin local input/output connection to Pi Sessions, with exclusive data-directory ownership, conversation pointers, input deduplication and minimal helper observation. It owns no generic Task settlement or permission framework.

**Channel**: Authenticates input and delivers text, images and files. Telegram renders rich messages and temporary public reply previews; a preview is not a final send receipt.

**Conversation**: Stable identity selecting a main Session and saved work directory. Telegram uses `telegram:private:<owner id>`; CLI can explicitly select a conversation.

**Work Directory**: Default directory for relative paths and project instructions. Reopening a conversation preserves it. It is separate from Session storage and is not a sandbox.

**Delegation**: Work entrusted to an external helper through herdr-workflow. The main assistant checks actual files, diffs and command results before continuing the user's goal. Status and self-report do not prove success.

**Helper Observation**: Minimal versioned record of session, agent, workspace, pane, cwd and prompt identity. The Pi extension observes an already dispatched helper in the background and returns external materials to the correct main Session. Restart queries real identity and state; it never blindly launches work again.

**Steering**: New user input delivered through native Pi steering during an active tool turn. Supplements for an external helper are separately routed by the skill; unrelated conversation stays with the main assistant.

**Stop**: Explicit request handled against the actual external helper identity and process state. Unknown termination is reported honestly; existing effects remain.

**Trusted Local Execution**: Native tools inherit the starting account's permissions. User and project instructions govern the scope; publishing, external messaging, major deletion and merge require corresponding authorization.

**Result Inspection**: Purpose-specific checks of actual artifacts and target-project validation. No universal submission, verification or completion form is required for ordinary replies.

**Send Receipt**: Telegram's minimal sending/sent/rejected/unknown record. Unknown sends are not automatically retried. This is separate from the success of the user's work.

**Historical Host / Task / Attempt / Akasha / Plan**: Retired online concepts retained in older documentation and offline diagnostics. The new data namespace neither loads nor migrates those records. Proactive responsibilities and timers are deferred.

## Agreed design language: queue and workflow

These terms describe the confirmed direction in the [queue and workflow discussion](docs/research/event-queue-durable-workflow-2026-10-15.md), not additional guarantees of the current runtime. [ADR-0011](docs/adr/0011-durable-main-agent-and-conversation-queue.md) selects Pi Durable for main-agent execution and a nailong-owned persistent queue for routing, deduplication, priority and FIFO; production migration is pending. This replaces native Steering as the planned scheduling policy: equal-priority direct inputs wait in arrival order.

**Input Event**: External input for the Personal Agent, such as a direct user message or a future scheduled, mail or thread notification. A delegated helper's return is internal execution material, not a message authored by the user.

**Queue System**: The combination of input routing, deduplication and conversation selection with each Conversation's queue of pending input.

**Processing Turn**: One period in which the main agent handles selected input. It can end after delegating background work; completion of the user's whole goal is not required to release the conversation for later input.

**Input Batch**: An ordered group of already queued ordinary Input Events selected when a Conversation is idle or its current Processing Turn ends. Each event retains its identity and message boundary; grouping does not imply a shared goal. Selection adds no timed wait and stops at commands or a change of source or priority.

**Explicit Steering**: A user-authored `/steer` command that supplements current work at the next supported input boundary. Multiple accepted supplements may be read together in order, retaining their identities. Ordinary input remains queued for a later Processing Turn; steering is separate from stopping or priority preemption, and does not immediately stop running tools.

**Event Priority**: The ordering that permits higher-priority input to interrupt lower-priority processing. Direct user inputs have equal priority to each other and wait in arrival order; they outrank background input.

**Durable Workflow**: Saved execution progress and confirmed model/tool results that allow interrupted work to continue without repeating completed operations solely because execution restarted. It is separate from conversation history and helper-local context.
