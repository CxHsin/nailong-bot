# Nailong Bot Agent Context

Nailong Bot is a personal agent whose Host runs conversations and durable runs, while channels such as Telegram and CLI accept input and project progress and delivery back to people.

## Language

**Host**:
The channel-independent runtime that accepts a message input, owns the conversation and run lifecycle, invokes the agent, records runtime facts, and emits ordered run events.
_Avoid_: Telegram bot, daemon (unless referring to a future deployment shape)

**Channel**:
A user-facing adapter that authenticates an actor, normalizes input, and projects Host events into a channel's interaction model.
_Avoid_: transport (which may refer only to a low-level API)

**Conversation**:
A durable cross-channel identity that selects the history and context projection used for a sequence of runs.
_Avoid_: chat (unless referring to a channel UI)

**Run**:
One ordered attempt by the Host to process an input and produce a result or terminal failure.
_Avoid_: request (except for compatibility with existing runtime events)

**Follow-up**:
A subsequent user input held until the current work finishes before being processed in the same Conversation. Ordinary user messages received during active work are Follow-ups by default.
_Avoid_: steering input

**Steer**:
An explicit user input that changes the direction or constraints of active work at an execution boundary. It takes effect after the current batch of tools completes.
_Avoid_: follow-up, immediate interruption

**Stop**:
A user action that stops active work and cancels pending user inputs in the same Conversation. Completed actions and their effects remain facts rather than being rolled back.
_Avoid_: reset, undo

**Content Part**:
A typed text or image item in a normalized user or assistant message, independent of any channel SDK.
_Avoid_: Telegram message payload

**Progress Event**:
An ordered semantic event describing model-visible summary, runtime fact, or run state for channel projection; it is not automatically part of model context.
_Avoid_: status string

**Run Summary**:
A short, read-only explanation produced by an auxiliary model from committed runtime facts during a silent active Run. Its provenance is recorded; valid settled summaries may enter Context Projection, but never Akasha memory content.
_Avoid_: reasoning, execution result

**Settled Text**:
An assistant text unit committed after a normal model step. Text accompanying tool calls is progress; text ending a step without tool calls is the final answer. Draft deltas are previews rather than Settled Text.
_Avoid_: delivered message (settlement does not prove delivery)

**Context Projection**:
The Provider-aware transformation from durable runtime records into the exact model input items for one request.
_Avoid_: chat history (which includes records that may never be sent to a model)

**Recent Turn**:
One user input and its replayable assistant messages and paired tool exchanges.
_Avoid_: model step, three messages

**Active Context**:
The bounded conversation state available to the model for continuing work, including retained original turns, supporting material and compaction state when present. Its continuity survives a process restart through a durable start boundary, recorded model-visible views and frozen compaction facts; validated snapshots are disposable derived caches. Older details remain recoverable from durable history and Akasha. Exact original coverage, partial original ranges and lossy summary involvement have distinct roles in memory recovery.
_Avoid_: complete runtime history, server-side KV cache

**Delivery Fact**:
A durable record of a channel delivery attempt and its known outcome, scoped to a run result and channel target.
_Avoid_: assistant message (which may exist before delivery)
