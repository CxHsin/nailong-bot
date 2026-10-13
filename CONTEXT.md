# Nailong Bot Agent Context

Nailong Bot is a personal agent on the user's Windows computer. Telegram and CLI share a Host; lightweight work uses the main Session and independent helpers return materials to it. Work-context boundaries: [ADR-0009](docs/adr/0009-runtime-work-context.md), extending [ADR-0008](docs/adr/0008-personal-agent-orchestration-direction.md). Earlier implementation evidence: [#167 acceptance](docs/personal-agent-acceptance-20261013.md).

## Language

**Personal Agent**: A persistent personal counterpart for ongoing conversation and work across the user's activities. Coding is one capability within this role; building another comprehensive coding agent is not the product goal.

**Delegation**: Work entrusted by the Personal Agent to a helper, with results returned to the Personal Agent for continued handling of the user's goal. The Personal Agent handles lightweight work directly and delegates work that requires substantial time or a separate context.

**Standing Responsibility**: An ongoing duty explicitly entrusted by the user to the Personal Agent, within an authorized scope. It calls for continued follow-through and selective reporting of meaningful developments or decisions needing the user.

**Memory Context**: Original historical expressions and experiences recalled as relevant background for the current question. Their source, role and time matter; they do not define a fixed user personality or replace current instructions and factual evidence.

**Host**: Channel-independent owner of durable inputs, Tasks, scheduling, authorization, recovery, acceptance and Delivery. Business records are direct SQLite state.

**Runtime**: The agent execution loop that assembles model context, invokes the model and executes tools. It associates each result with the work requirements actually presented; receiving a requirement is separate from presenting it.

**Channel**: Authenticates input and delivers text or files. Telegram renders Markdown rich messages and temporary public reply previews; previews are not Delivery facts. Owns no agent loop or task state.

**Conversation**: Durable identity selecting a main Pi Session, saved work directory and execution mode, and scoped Akasha sources. Actor identity separately authorizes task operations.

**Work Directory**: The directory used to interpret relative work paths and project instructions. Local interactive work starts from the launch directory; reopening existing work preserves its directory. It is separate from Session storage and is not itself a permission boundary.

**Task**: Durable overall work or child delegation: goal, parent/root identity, current requirements and revision, resources, permission, executor, status and result. Its identity survives attempts and restart. Avoid Run as a synonym.

**Attempt**: One executor invocation belonging to a Task, with actual execution identity and usage.

**Session**: Pi-native model exchanges and compaction. Main and task Sessions are separate; Session completion proves neither task completion nor process termination.

**Native Tool Discovery**: Supported configured Responses/Anthropic profiles use per-Session provider adapters and versioned native history; deferred execution requires a current-context discovery and its own authorization. See [implementation and verification limits](docs/native-tool-search.md).

**Steer**: A requirement appended to an identified Task. Receipt, acknowledgement and application are distinct. Acceptance uses current revision; existing effects remain.

**Stop**: Durable cancellation of an identified Task. Actual termination releases resources; unknown effects remain waiting and occupied. Other independent Tasks remain active.

**Resource**: Canonical workspace/path whose overlap serializes conflicting Tasks. Unknown occupancy is not free.

**Action Authorization**: Exact action kind, target, parameters and content under a Task revision. A consumed approval cannot dispatch twice; changed scope needs confirmation.

**Work Permission**: The execution authority granted to work: restricted read/write roots, network access and expiry, or trusted local access. Local interactive startup defaults to full access; other entries and saved work keep their own grants. A child can only narrow its parent's grant. Discovery and remembered instructions do not grant authority; trusted execution inherits the starting account's authority.

**Work Event**: Durable material addressed to a parent work, with unique identity and Session injection/completion receipts. Child completion, overall completion and Delivery remain separate facts. An unknown effect pauses later dispatches even with a new call ID.

**Research Source Receipt**: Actual provider-returned content and requested URL tied to a successful controlled retrieval, its digest, adapter version, owner and root work. Generated files and arbitrary returned metadata cannot authenticate remote retrieval; retrieval evidence does not establish a claim's truth.

**Working Agreement**: Explicitly confirmed rule with work/project/global scope, revisions and revocation. Current instructions take precedence; ordinary conversation and memory do not create rules automatically or expand permission.

**Plan**: Explicit user instruction with time/dependency trigger, timezone, deadline and missed-trigger policy. Consumption and Task creation are atomic.

**Acceptance**: Purpose-specific inspection of actual research sources, file changes or coding artifacts and checks against current requirements. The main Session judges the overall goal; idle and executor assertions alone cannot establish success. Invalid declared sources preserve partial results even when another artifact is valid.

**Completion Intent**: An explicit judgment that an overall Task is complete, associated by Runtime with the presented requirements and checked by Host. An ordinary answer ending, a tool error explanation and a child result do not establish overall completion.

**Delivery**: Durable text/file send with sent/rejected/unknown outcome, separate from Task success. Split pages have individual outcomes.

**Akasha**: Original-source retrieval, graph associations, exclusion and delivered-turn learning. Owns neither scheduling nor Pi context replay. No stable preference profile.

**Context Exclusion**: A source no longer enters memory/model input. Historical facts remain; affected Sessions retire and source-dependent obligations stop or pause conservatively.

**Historical Run / Context Projection / Active Context**: Terms for retired event-log execution and retained offline interpretation. Old Runs do not become new Tasks; native Pi Sessions own online continuity.
