# Nailong Bot Agent Context

One personal assistant uses a nailong-owned persistent Queue System and Pi Durable 1.2.0 through Telegram or CLI. Current design: [ADR-0011](docs/adr/0011-durable-main-agent-and-conversation-queue.md), [spec #201](https://github.com/CxHsin/nailong-bot/issues/201); migration verification is recorded in [current acceptance](docs/durable-assistant-acceptance-20261015.md). [ADR-0010](docs/adr/0010-native-pi-assistant.md) and older Host terminology retain historical evidence.

## Language

**Personal Agent**: The main assistant for ongoing conversation and work. Coding is one capability, delegated through the project herdr-workflow skill when appropriate.

**Session**: The main agent's model context within a Conversation. Resetting that context does not cancel queued or executing work. A completed model turn does not prove the user's goal or an external process has completed.

**Assistant Service**: Local coordination of authenticated input/output, the Queue System, Durable Workflow execution and helper materials. It owns exclusive data-directory access and per-Conversation serialization, with no generic Task settlement or permission framework.

**Channel**: Authenticates input and delivers text, images and files. Telegram renders rich messages and temporary public reply previews; a preview is not a final send receipt.

**Conversation**: Stable identity selecting a main Session and saved work directory. Telegram uses `telegram:private:<owner id>`; CLI can explicitly select a conversation.

**Work Directory**: Default directory for relative paths and project instructions. Reopening a conversation preserves it. It is separate from Session storage and is not a sandbox.

**Delegation**: Work entrusted to an external helper through herdr-workflow. The main assistant checks actual files, diffs and command results before continuing the user's goal. Status and self-report do not prove success.

**Helper Observation**: Saved session, agent, workspace, pane, cwd and prompt identity for an already dispatched helper. Returns are internal materials, saved before delivery to the correct main agent after queued direct input. Restart queries real identity and state; it never blindly launches work again.

**Steering**: Explicit user supplementation of current main-agent work; see Explicit Steering below. Supplements for an external helper are separately routed by the skill.

**Stop**: Explicit request handled against the actual external helper identity and process state. Unknown termination is reported honestly; existing effects remain.

**Trusted Local Execution**: Native tools inherit the starting account's permissions. User and project instructions govern the scope; publishing, external messaging, major deletion and merge require corresponding authorization.

**Result Inspection**: Purpose-specific checks of actual artifacts and target-project validation. No universal submission, verification or completion form is required for ordinary replies.

**Send Receipt**: Telegram's minimal sending/sent/rejected/unknown record. Unknown sends are not automatically retried. This is separate from the success of the user's work.

**Historical Host / Task / Attempt / Akasha / Plan**: Retired online concepts retained in older documentation and offline diagnostics. The new data namespace neither loads nor migrates those records. Proactive responsibilities and timers are deferred.

## Queue and workflow

These terms follow the [confirmed specification](https://github.com/CxHsin/nailong-bot/issues/201) and [ADR-0011](docs/adr/0011-durable-main-agent-and-conversation-queue.md). Equal-priority direct inputs wait in arrival order; ordinary input does not implicitly steer current work. Implementation verification belongs in the acceptance record, not in these definitions.

**Input Event**: External input for the Personal Agent, such as a direct user message or a future scheduled, mail or thread notification. A delegated helper's return is internal execution material, not a message authored by the user.

**Queue System**: The combination of input routing, deduplication and conversation selection with each Conversation's queue of pending input.

**Processing Turn**: One period in which the main agent handles selected input. It can end after delegating background work; completion of the user's whole goal is not required to release the conversation for later input.

**Input Batch**: An ordered group of already queued ordinary Input Events selected when a Conversation is idle or its current Processing Turn ends. Each event retains its identity and message boundary; grouping does not imply a shared goal. Selection adds no timed wait and stops at commands or a change of source or priority.

**Explicit Steering**: A user-authored `/steer` command that supplements current work at the next supported input boundary. Multiple accepted supplements may be read together in order, retaining their identities. Ordinary input remains queued for a later Processing Turn; steering is separate from stopping or priority preemption, and does not immediately stop running tools.

**Event Priority**: The ordering that permits higher-priority input to interrupt lower-priority processing. Direct user inputs have equal priority to each other and wait in arrival order; they outrank background input.

**Durable Workflow**: Saved execution progress and confirmed model/tool results that allow interrupted work to continue without repeating completed operations solely because execution restarted. It is separate from conversation history and helper-local context.

**Paused Work**: A retained Processing Turn awaiting explicit user continuation or verification of an unknown effect. Restart preserves this state; `/resume` explicitly requests continuation within the same Conversation.
