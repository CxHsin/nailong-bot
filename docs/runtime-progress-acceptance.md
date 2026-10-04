# Runtime progress acceptance — 2026-10-05

Implementation: #84, specification: #83, design: #82. Branch: `refactor/runtime-event-progress`.

## Automated verification

- Full regression: **252/252 passed**, no skipped or cancelled tests (54.99s).
- After that run, the extra post-commit/main-text race case was added; the latest focused Runtime progress run passed **11/11**.
- Migration public boundary: **5/5**; Telegram draft scheduling: **13/13**; rich rendering/fallback: **8/8** in their latest focused runs.
- `npm run typecheck`, `npm run build` and `git diff --check` passed.
- Standards and Spec reviews were run independently. Evidence projection, discarded replay, two summary races, slow formal delivery and migration report gaps were corrected. Both reviewers found no remaining substantive defect in their final recheck.

The regression evidence includes actual Pi execution with a local Provider stream, Host/Channel integration, real temporary event stores, unknown/partial delivery and API-success/log-commit failure. It verifies summary frequency limits, provenance, replay and Akasha exclusion. These fixtures do not establish native Telegram rendering.

## Real DeepSeek verification

Four scenarios used the production Pi/Host/new SQLite/Telegram projection path with a capturing transport and fresh temporary directories. Model calls used the configured DeepSeek credential; no Telegram message was sent. The final prompt revision produced the following observed results:

| Scenario | Completion | Visible behavior | Tool calls |
| --- | --- | --- | --- |
| Compare two files | 3.20s | Two separate Chinese explanations, then a self-contained comparison table; unknown timeout units remained unknown | `ls`, two `read` calls |
| Missing expected file / change direction | 5.87s | Four Chinese explanations, including the missing-file finding and search for a baseline; final comparison explicitly states that active configuration cannot be determined | 11 calls, including file search/read and memory search |
| Short arithmetic | 0.67s | One final answer, `7 × 8 = 56。`; no progress message or tool | 0 |
| Long read | 41.74s | Primary explanation, one independent summary and a separate final answer; unrecorded units were not invented | one `read` |

The long-read test deliberately held the first committed tool dispatch for **40 seconds** to exercise the default 15-second silence trigger. It used the real primary and auxiliary models, but the delay was injected, not measured external service latency. The summary stated that file contents had not arrived and retained its dispatch event as evidence. Auxiliary usage was recorded as `purpose: progress`: **144 input + 22 output = 166 tokens**, one call. Provider cost metadata is an estimate, not billing evidence.

Earlier prompt revisions sometimes emitted English tool commentary or inferred milliseconds/active configuration from convention. The final prompt explicitly treats tool-adjacent text as user-visible content, reinforces configured language, gives concrete progress examples and prohibits filling missing units or source authority with assumptions. The final four samples satisfied those boundaries; this sample is not proof that every future model response will do so. The direction-change case also searched more widely than needed, which remains a model efficiency limitation.

## Pending live acceptance

**Telegram client acceptance is pending a named test chat and explicit sending authorization.** It must check actual streamed drafts, separate fixed progress messages, visible titles and expandable quotes, fallback on unsupported clients, long code/table/Unicode content on mobile and independent final answers.

No production Bot restart, deployment, source migration or live message was performed. #83 and #84 remain open until the client acceptance is recorded. Source stores are retained by the migration implementation; actual production cutover requires stopping the existing writer first.
