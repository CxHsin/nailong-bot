# Web result presentation acceptance — 2026-10-06

Design: [#88](https://github.com/CxHsin/nailong-bot/issues/88). Implementation: [#89](https://github.com/CxHsin/nailong-bot/issues/89). Branch: `fix/telegram-web-freshness`.

## Change and boundaries

Large `web_fetch` batches now retain per-page URLs, titles, short bodies, bounded long-body previews, page links and per-URL errors. Pages of at most 4,096 UTF-16 code units start with a full body; longer pages start with a 240-code-point preview. The serialized content budget is 7,000 UTF-8 bytes, so many short pages may also require continuation. Long previews are trimmed first. Link previews prefer descendants of the current page's URL path, then other links; complete links remain readable.

The existing `read` tool can read a selected webpage through the supplied `#web=<page>&sha256=...&byte=...` path. Reading a webpage archive without a fragment now returns all page bodies and links as readable text, not nested escaped JSONL. Page zero denotes the combined view. Reads stay within the existing 7,500-byte response limit and preserve line/UTF-8 continuation boundaries, including blank lines and trailing newlines. Legacy `#sha256=...&byte=...` cursors retain their JSONL interpretation.

Original responses and archive files are unchanged. Hash/source verification and memory-exclusion checks still precede decoded reads. Non-web tools retain their existing archive presentation. Tool projection version 2 records the new preview; version 1 replay continues to show the prior placeholder.

Also included: `web_fetch` defaults to `ttl: 0` while preserving explicit values; ordinary Telegram progress no longer receives the heading “进展”. The independent summary heading remains. TinyFish's `ttl: 0` prefers live retrieval but can still accept origin cache policy or operator-pinned cache entries.

## Controlled real-model comparison

The final experiment used the configured real `deepseek-flash` model, real TinyFish calls after an identical seeded public-web response, and the production projection/archive-read functions. It did not send Telegram messages, write production events, or invoke memory learning. Trials alternated the two modes, three times each, with a limit of 15 model steps, 2,048 output tokens per step and a 180-second per-trial signal. Subsequent web calls used the same fresh-fetch default in both modes.

The seed is the first public-web response captured during the failed retry: a short GitHub skills directory, a long CHANGELOG, and a code-search HTTP 401. The question was fixed to asking for the actual definition of `chief-of-staff` in `mattpocock/skills`. This is a controlled continuation from the same evidence, not a replay of the full original Conversation, and the runner does not replicate all Pi/Host policies. A separate automated test exercises the actual Pi tool interception and next-turn replay.

| Mode / trial | Read definition and finish | Subsequent tool calls | Seconds | Provider total tokens |
| --- | --- | --- | --- | --- |
| Archive only / 1 | No; step limit | 16 | 21.7 | 180,064 |
| Page preview / 1 | Yes | 13 | 42.7 | 129,292 |
| Archive only / 2 | Yes | 13 | 24.8 | 141,888 |
| Page preview / 2 | Yes | 10 | 20.3 | 79,306 |
| Archive only / 3 | Yes | 6 | 18.0 | 47,495 |
| Page preview / 3 | Yes | 5 | 17.0 | 44,111 |

The final sample yielded **2/3 vs 3/3** definition retrieval/completion. Mean subsequent calls were **11.7 vs 9.3**; mean total tokens were **123,149 vs 84,236** (about 32% lower). Mean wall time was **21.5 vs 26.7 seconds**; the new mode was not faster overall. Failure runs are included and the failed old-mode run ended early at the step limit, so these means do not establish comparative time-to-success. Total tokens include repeated cached input and output across calls and are not a billing figure. The seeded call is excluded from time/call/token totals equally for both modes.

Success required observed definition content in the model-visible tool result and a completed final response. Manual inspection confirmed the final answers quoted the correct frontmatter and described coordinating subagents toward a long-running goal. It does not certify every extra claim: one answer incorrectly grouped other skills under `productivity`, and answers remain longer than necessary. Three trials per mode cannot establish general reliability or prove a causal performance claim about other agents such as Maka.

Exploratory runs uncovered a second presentation defect before the final comparison: GitHub's extracted directory text omitted the skill name while its returned link list contained the exact `chief-of-staff` path. A body-only preview hid this evidence. The implementation now retains links in both preview and decoded continuation. Those earlier runs used different implementations and are excluded from the final six-trial table.

## Reproduce and inspect

Runner: `test/manual/web-result-evaluation.ts`. It requires `DEEPSEEK_API_KEY` and `TINYFISH_API_KEY`, invokes billable real services, and accepts a captured public-web `ToolResult` JSON and a new output directory:

```powershell
node --env-file=.env --import tsx test/manual/web-result-evaluation.ts <capture.json> <output-directory>
```

Each output directory contains `metrics.json` and per-trial contexts/runtime archives. The local final artifacts are under `.scratch/web-result-evaluation-v3-20261006/`; they are not committed. The maintained report contains aggregate evidence rather than API credentials or private Conversation history.

Automated coverage checks short-page preservation with a long sibling, link-only evidence, per-URL errors, response budgets, Unicode/single-line/blank-line continuation, complete combined-body reconstruction, invalid page/hash rejection, malformed-envelope fallback, non-web behavior, v1/v2 replay and actual Pi tool/replay integration. Deployment and native-client acceptance remain separate; the production Bot was not restarted for this change.

Final full regression: **264/264 passed**, zero skipped/cancelled tests (142.13s). The latest archive/web focused run passed **11/11**. Typechecking, build and `git diff --check` passed.
