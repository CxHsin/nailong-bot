---
status: accepted
---

# Preserve production behavior and durable data while retiring internal paths

This refactor improves the existing Host, Agent, Channel and Projection boundaries while retaining TypeScript, Pi SDK and SQLite. Compatibility covers current Telegram/CLI production behavior, configuration and durable data; it does not require keeping every old internal API. After checking callers and unique semantics, migrate valuable regression coverage and retire confirmed redundant paths. Do not introduce legacy-only behavior into production or remove unclear code merely because tests are its remaining callers.

Keeping every internal path would preserve duplicate responsibilities and the separate continuous/recent-turn policies. Retiring paths without tracing their behavior would instead risk losing valuable guarantees. Production and retained legacy paths therefore keep their existing policies until their individual retirement is verified. [ADR-0003](0003-recent-turn-context.md) remains applicable to the retained createApp adapter; this decision does not declare that adapter removed. The independent Projections and shared committed Runtime Event Log boundary from [#39](https://github.com/CxHsin/nailong-bot/issues/39), and the production semantics of ADR-0001, ADR-0002, ADR-0004 and ADR-0005, remain in force.

Review source, tests and documentation across the project, changing modules where there is concrete benefit rather than requiring every file to change. Keep this work behavior-preserving: report discovered defects and performance concerns separately, with reproductions or measurements, before agreeing on behavior changes. Plugin use cases remain unresolved, so defer the plugin system and its loading, installation and lifecycle contracts to a future design. Improve current interfaces for current responsibilities rather than treating speculative plugin abstractions as acceptance criteria.

Confirmed during the 2026-10-10 grill-with-docs discussion: [#142](https://github.com/CxHsin/nailong-bot/issues/142). The conclusion precedes a separate specification and implementation tasks; it does not authorize deployment or a process restart.
