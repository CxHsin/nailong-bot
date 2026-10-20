# Nailong Bot Agent Context

One personal assistant uses a nailong-owned persistent Queue System and Pi Durable 1.2.0 through Telegram or CLI. Current design: [ADR-0011](docs/adr/0011-durable-main-agent-and-conversation-queue.md), [spec #201](https://github.com/CxHsin/nailong-bot/issues/201); migration verification is recorded in [current acceptance](docs/durable-assistant-acceptance-20261015.md). [ADR-0010](docs/adr/0010-native-pi-assistant.md) and older Host terminology retain historical evidence.

Stable context and shared long-term memory follow [ADR-0012](docs/adr/0012-layered-memory-and-stable-context.md) and [spec #208](https://github.com/CxHsin/nailong-bot/issues/208). Budgets, storage and verification are in [operations](docs/personal-agent-operations.md) and [context acceptance](docs/context-management-acceptance-20261016.md).

Akasha follows [ADR-0017](docs/adr/0017-port-akasha-engine-and-independent-embedding.md), [conclusion #267](https://github.com/CxHsin/nailong-bot/issues/267) and [spec #268](https://github.com/CxHsin/nailong-bot/issues/268). The TypeScript core in [akasha](src/assistant/akasha) provides semantic and lexical features, graph association, causal learning and readout; the [memory adapter](src/assistant/akasha-memory.ts) uses independently selected Embedding services. Queue and Durable facts qualify closed experiences; valid originals without closure remain searchable. Each actual input saves and reuses its recall, including empty or degraded results. Current implementation, original Python comparisons, real Embedding evidence and integration checks are recorded in [Akasha acceptance](docs/akasha-integration-acceptance-20261020.md). Production activation and phone observation require separate evidence. The settled scope remains in the [design discussion](docs/research/akasha-integration-design-2026-10-20.md) and [spec archive](docs/research/akasha-integration-spec-2026-10-20.md).

System ordering and authoritative SELF follow [ADR-0015](docs/adr/0015-system-context-order-and-self-file.md) and [spec #234](https://github.com/CxHsin/nailong-bot/issues/234). Base instructions, skills, project instructions, SELF and MEMORY retain that effective order. Identity and core persona change only through the user's explicit current request; relationship and expression may evolve from sourced user evidence.

The Conversation Control Panel and Magpie Model Catalog follow [ADR-0016](docs/adr/0016-magpie-catalog-and-conversation-settings.md), [conclusion #242](https://github.com/CxHsin/nailong-bot/issues/242) and [spec #244](https://github.com/CxHsin/nailong-bot/issues/244). The official Telegram/CLI entry uses Magpie's catalog; Conversation-owned choices, thinking preferences, favorites and drafts persist in the existing data directory. Native Telegram controls remain available during requests and tools, and the next prepared request adopts new settings. The Agent plugin shares only the owner's Telegram main Conversation model. Automated behavior and live integration evidence are recorded in [control acceptance](docs/conversation-control-acceptance-20261018.md); actual plugin menu echo and phone acceptance remain pending. Magpie-side thinking controls are deferred under [#243](https://github.com/CxHsin/nailong-bot/issues/243).

Conversation settings coordination follows [spec #251](https://github.com/CxHsin/nailong-bot/issues/251). The [coordination module](src/assistant/conversation-settings.ts) owns settings snapshots, per-Conversation synchronization, global propagation, Durable configuration, run eligibility and synchronization lifetime. Runtime owns routing and queue scheduling. Control queries retain the wait for settings propagation across all registered Conversations; Magpie persistence and Durable request checkpoints retain their existing responsibilities.

The extension in [conclusion #259](https://github.com/CxHsin/nailong-bot/issues/259) and [spec #260](https://github.com/CxHsin/nailong-bot/issues/260) adds a global Routing Model selector to the Conversation Control Panel, using Magpie's catalog independently of the main model. Its saved service-wide choice is frozen when each routing judgment starts; legacy production routing aliases are retired. Telegram Persona Expression and Satiety use the existing data directory, authenticated Channel and current input identities. Home controls provide feeding and cache details without generation; a separate auxiliary startup greeting tests the selected main model without creating work or resuming paused work. Implementation and external acceptance have separate evidence in the [acceptance record](docs/nailong-persona-acceptance-20261020.md). See the [design record](docs/research/nailong-persona-design-2026-10-19.md), [spec archive](docs/research/nailong-persona-spec-2026-10-19.md) and [ADR-0016](docs/adr/0016-magpie-catalog-and-conversation-settings.md).

## Language

**Personal Agent**: The main assistant for ongoing conversation and work. Coding is one capability, delegated through the project herdr-workflow skill when appropriate.

**Session**: The main agent's model context within a Conversation. Resetting that context does not cancel queued or executing work. A completed model turn does not prove the user's goal or an external process has completed.

**Assistant Service**: Local coordination of authenticated input/output, the Queue System, Durable Workflow execution and helper materials. It owns exclusive data-directory access and per-Conversation serialization, with no generic Task settlement or permission framework.

**Channel**: Authenticates input and delivers text, images and files. Telegram renders rich messages and temporary public reply previews; a preview is not a final send receipt.

**Conversation**: Stable identity selecting a main Session and saved work directory. Telegram uses `telegram:private:<owner id>`; CLI can explicitly select a conversation.

**Conversation Control Panel**: A unified Telegram interface for viewing a Conversation's status, choosing the main assistant's model and thinking level, and accessing conversation operations.

**Model Catalog**: The models offered for selection by a connected model service, together with their known capabilities. The Magpie catalog reflects the models the user has enabled there.

**Routing Model**: The model that interprets an Input Event's relationship to existing work and proposes Routing Actions. Its selection is shared across the Assistant Service's Conversations and is independent of each Conversation's main model.

**Work Directory**: Default directory for relative paths and project instructions. Reopening a conversation preserves it. It is separate from Session storage and is not a sandbox.

**Delegation**: Work entrusted to an external helper through herdr-workflow. The main assistant checks actual files, diffs and command results before continuing the user's goal. Status and self-report do not prove success.

**Helper Observation**: Saved session, agent, workspace, pane, cwd and prompt identity for an already dispatched helper. Returns are internal materials, saved before delivery to the correct main agent after queued direct input. Restart queries real identity and state; it never blindly launches work again.

**Steering**: The Durable mechanism that delivers an identified Work Supplement at a supported input boundary. The former user command is retired.

**Stop**: Explicit request handled against the actual external helper identity and process state. Unknown termination is reported honestly; existing effects remain.

**Trusted Local Execution**: Native tools inherit the starting account's permissions. User and project instructions govern the scope; publishing, external messaging, major deletion and merge require corresponding authorization.

**Result Inspection**: Purpose-specific checks of actual artifacts and target-project validation. No universal submission, verification or completion form is required for ordinary replies.

**Send Receipt**: Telegram's minimal sending/sent/rejected/unknown record. Unknown sends are not automatically retried. This is separate from the success of the user's work.

**Long-term Memory**: Shared sourced MEMORY facts/preferences, SELF identity/persona/relationship/expression, and global or Work Directory topics. Current user corrections replace old claims. Memory helps understanding; Durable Workflow and external evidence determine execution state.

**SELF**: The current authoritative definition of the assistant's identity, persona, interaction principles and sourced relationship/expression understanding. Local configuration remains distinguishable from original user evidence. Current SELF and an actual generation's frozen snapshot are different facts.

**Persona Expression**: The Personal Agent's nailong manner of speaking and interacting while remaining a reliable assistant. Work-status feedback reflects actual events; conversational expression may be chosen by the agent to suit the context.

**Satiety**: The Personal Agent's playful state of fullness, used for feeding interactions and persona expression. It does not reduce work capability, accuracy or availability, and does not require feeding before work can continue.

**Akasha Recall**: Bounded retrieval of original records using the current real user Input Event. Sources retain role, time and identity; historical records are evidence, not current instructions. Each input's automatic retrieval, including no matches, is saved and reused.

**Akasha Engine**: The semantic retrieval, association and learning mechanism used to find relevant original experiences. It is distinct from resident MEMORY/SELF files and from the execution facts held by Durable Workflow.

**Embedding Space**: A compatible semantic coordinate system in which text vectors can be compared. Vectors from different spaces do not share similarity or learned associations merely because their dimensions match.

**Memory Snapshot**: Actual resident memory material saved for one context generation. Ordinary changes append immediately; compaction or reset starts a new snapshot. Forgetting invalidates affected snapshots, recalled material and derived summaries immediately.

**Tool Archive**: Persistent original tool output with a stable reference, bounded view and searchable provenance. Known references can be paged directly; missing references can be discovered without replaying the tool. It shares the Conversation data lifetime.

**Default Forgetting**: Retracts derived memories and excludes the corresponding original sources and their derivatives from automatic recall and learning. Unrelated work progress remains available. Original records remain; physical deletion is a separate request.

**Profile Maintenance**: Persisted extraction ranges, validated drafts and apply receipts recover after failures without resuming main work. Consolidation merges existing sourced facts; capacity retirement preserves searchable originals and differs from Default Forgetting. Successful explicit memory-tool receipts alone provide graph feedback for closed experiences. See [maintenance acceptance](docs/akasha-memory-maintenance-acceptance-20261020.md).

**Historical Host / Task / Attempt / Akasha / Plan**: Retired systems recorded in historical documentation and versioned source. Their implementations, offline tools and old helper import are retired under [ADR-0014](docs/adr/0014-retire-legacy-code-and-data.md). Production memory uses its own namespace and never imports their records. Proactive responsibilities and timers are deferred.

## Queue and workflow

These terms follow [spec #201](https://github.com/CxHsin/nailong-bot/issues/201), [spec #215](https://github.com/CxHsin/nailong-bot/issues/215) and [ADR-0013](docs/adr/0013-contextual-input-routing.md). Independent direct requests wait in arrival order; Work Supplements and cancellation refer to identified work. Implementation verification belongs in the acceptance record, not in these definitions.

Input routing follows contextual Work Supplements and retirement of the dedicated user command. Current implementation and live verification status are recorded in [routing acceptance](docs/contextual-input-routing-acceptance-20261016.md).

**Input Event**: External input for the Personal Agent, such as a direct user message or a future scheduled, mail or thread notification. A delegated helper's return is internal execution material, not a message authored by the user.

**Queue System**: The combination of input routing, deduplication and conversation selection with each Conversation's queue of pending input.

**Processing Turn**: One period in which the main agent handles selected input. It can end after delegating background work; completion of the user's whole goal is not required to release the conversation for later input.

**Input Batch**: An ordered group of already queued ordinary Input Events selected when a Conversation is idle or its current Processing Turn ends. Each event retains its identity and message boundary; grouping does not imply a shared goal. Selection adds no timed wait and stops at commands or a change of source or priority.

**Work Target**: A stable reference to one independent user objective, preserving its original input and FIFO position. An Input Event can express several targets or actions; an Input Batch is their execution container.

**Routing Action**: One ordered request, supplement, cancellation or clarification from an original Input Event, with a stable identity and confirmed delivery progress. A model chooses meaning and a supplied target; execution facts determine whether the action applies.

**Event Priority**: The ordering that permits higher-priority input to interrupt lower-priority processing. Direct user inputs have equal priority to each other and wait in arrival order; they outrank background input.

**Durable Workflow**: Saved execution progress and confirmed model/tool results that allow interrupted work to continue without repeating completed operations solely because execution restarted. It is separate from conversation history and helper-local context.

**Paused Work**: A retained Processing Turn awaiting explicit user continuation or verification of an unknown effect. Restart preserves this state; `/resume` explicitly requests continuation within the same Conversation.

## Input intent

**Input Intent**: The user's meaning in an Input Event, interpreted with the relevant ongoing work and conversation context. It includes whether the message supplements existing work, requests separate work, or cancels identified work.

**Work Supplement**: A user's addition or correction to ongoing work, including work delegated to a helper. Its relationship to that work follows from context rather than a dedicated command.
