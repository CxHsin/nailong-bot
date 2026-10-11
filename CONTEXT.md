# Nailong Bot Agent Context

Nailong Bot is a personal agent on the user's Windows computer. Telegram and CLI share a Host, with main conversation independent of durable Tasks. Current architecture: [ADR-0007](docs/adr/0007-personal-host-native-sessions.md).

## Language

**Host**: Channel-independent owner of durable inputs, Tasks, scheduling, authorization, recovery, acceptance and Delivery. Business records are direct SQLite state.

**Channel**: Authenticates input and delivers plain text or files. Owns no agent loop or task state.

**Conversation**: Durable identity selecting a main Pi Session and scoped Akasha sources. Actor identity separately authorizes task operations.

**Task**: Durable user obligation: goal, current requirements and revision, resources, executor, status and result. Its identity survives attempts and restart. Avoid Run as a synonym.

**Attempt**: One executor invocation belonging to a Task, with actual execution identity and usage.

**Session**: Pi-native model exchanges and compaction. Main and task Sessions are separate; Session completion proves neither task completion nor process termination.

**Steer**: A requirement appended to an identified Task. Receipt, acknowledgement and application are distinct. Acceptance uses current revision; existing effects remain.

**Stop**: Durable cancellation of an identified Task. Actual termination releases resources; unknown effects remain waiting and occupied. Other independent Tasks remain active.

**Resource**: Canonical workspace/path whose overlap serializes conflicting Tasks. Unknown occupancy is not free.

**Action Authorization**: Exact action kind, target, parameters and content under a Task revision. A consumed approval cannot dispatch twice; changed scope needs confirmation.

**Plan**: Explicit user instruction with time/dependency trigger, timezone, deadline and missed-trigger policy. Consumption and Task creation are atomic.

**Acceptance**: Independent inspection of actual artifacts and command evidence against current requirements. Idle and executor assertions alone cannot establish success.

**Delivery**: Durable text/file send with sent/rejected/unknown outcome, separate from Task success. Split pages have individual outcomes.

**Akasha**: Original-source retrieval, graph associations, exclusion and delivered-turn learning. Owns neither scheduling nor Pi context replay. No stable preference profile.

**Context Exclusion**: A source no longer enters memory/model input. Historical facts remain; affected Sessions retire and source-dependent obligations stop or pause conservatively.

**Historical Run / Context Projection / Active Context**: Terms for retired event-log execution and retained offline interpretation. Old Runs do not become new Tasks; native Pi Sessions own online continuity.
