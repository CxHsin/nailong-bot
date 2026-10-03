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

**Content Part**:
A typed text or image item in a normalized user or assistant message, independent of any channel SDK.
_Avoid_: Telegram message payload

**Progress Event**:
An ordered semantic event describing model-visible summary, runtime fact, or run state for channel projection; it is not automatically part of model context.
_Avoid_: status string

**Context Projection**:
The Provider-aware transformation from durable runtime records into the exact model input items for one request.
_Avoid_: chat history (which includes records that may never be sent to a model)

**Delivery Fact**:
A durable record of a channel delivery attempt and its known outcome, scoped to a run result and channel target.
_Avoid_: assistant message (which may exist before delivery)
