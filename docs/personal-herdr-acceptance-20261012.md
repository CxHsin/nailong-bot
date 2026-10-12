# Isolated Windows / herdr acceptance, 2026-10-12 Asia/Shanghai

Environment: Windows, herdr 0.8.2, Codex 0.162.0-alpha.17.2. Named session `nailong-accept-20261011`, temporary repo `C:/Users/Cx/AppData/Local/Temp/nailong-herdr-accept-20261011`. User's existing default session and production bot were not stopped or changed. No login credentials were read.

## Actual delegation

Started an isolated headless server with `Start-Process herdr --session nailong-accept-20261011 server` (hidden). Created a workspace with `workspace create --cwd <temporary repo> --label nailong-accept --no-focus`, returned w1 / w1:p1.

First `agent start` timed out: new pane PowerShell PATH could not find codex. Added only the installed Codex executable directory to that generated test pane PATH. Started via herdr with `agent start nailong-accept --kind codex --pane w1:p1 --timeout 30000 -- --sandbox workspace-write --ask-for-approval on-request --no-daemon --no-alt-screen`. Empty generated test repo initially required folder trust, accepted for that repo only. Normal adapter does not answer approval/trust dialogs.

Submitted a task to create `answer.txt` containing exact bytes 34 32 0A and run a local check. Real agent wrote it and reported PASS. Controller independently read exact content `42\n`, and inspected actual git diff (new answer.txt). These are actual execution/output checks, not version/help-only checks.

## Actual stop

Submitted finite writer: counter once per second for 120 iterations, no detached processes. Observed working and `stop-counter.txt` at 17, then captured dedicated shell+descendant IDs 15420, 20040, 35116, 12384, 36592, 14832, 36020. Closed only w1:p1 at count 33. Snapshot showed no panes/agents. All captured OS PIDs absent afterward; counter still 33 after approximately eight seconds. This proves the tested finite local process stopped; it does not claim arbitrary remote side effects or detached executors can be cancelled.

## Named server restart and PATH fix

Created w2:p1 with explicit `--env PATH=<current controller PATH>`. `agent start` now succeeded without a pane repair and returned actual argv matching workspace-write/on-request/no-daemon/no-alt-screen. Closed only that pane, stopped only named test session with `herdr session stop nailong-accept-20261011 --json`, then restarted the isolated headless server. Counter remained 33. Adapter now passes only PATH explicitly to newly created workspaces.

## Automated Host seam

`node --import tsx --test test/personal-herdr.test.ts`: seven passing tests at Host input/task/delivery boundary. Covers old idle, missing artifact, failed check, wrong workspace, unknown stop, supplemental requirements applied to a later turn, and independently checked actual artifact delivery. External herdr CLI is controlled beneath Host. Real delegation above is separately identified.

## Limits

Native Codex workspace-write/on-request is a real write/approval policy, not a hermetic credential-read sandbox. General shell commands and executors inherit authorized process permissions. No real Telegram credential/delivery test performed here. Claude requires separately verified launch policy; current real acceptance used Codex. Cold restart while active with uncertainty and detached external side effects need their own acceptance evidence.

## Actual Host / herdr integration and crash recovery

Ran `node --import tsx C:/Users/Cx/AppData/Local/Temp/nailong-herdr-host-accept.mts` with real PersonalHost, SQLite PersonalStore and default real HerdrExecutor. Controlled only dialogue intent (no production model/Telegram). Actual Codex wrote host-answer.txt (`64\n`). Host independently checked file contents, completed task cc9432b2-74a4-47d5-aca7-78e76664936d and recorded its artifact delivery. No manually repaired pane was needed: adapter passes explicit PATH to its generated workspace. State retained in `C:/Users/Cx/AppData/Local/Temp/nailong-herdr-host-u3Xr7p`.

Ran `node --import tsx C:/Users/Cx/AppData/Local/Temp/nailong-herdr-recovery-accept.mts` with real execution and an intentional process exit in the verifier, after herdr settled output but before Host committed completion. Task e6cf96aa-9e36-4af1-a4e5-4f644ce1a791 remained running in SQLite with persisted identity/observed-work evidence. Started a fresh Node process with `--recover`; Host re-associated existing idle executor, checked actual recovery-answer.txt (`128\n`) against persisted goal/revision, and completed the same task without another prompt or new agent. State retained in `C:/Users/Cx/AppData/Local/Temp/nailong-herdr-recover-n95DQ7`. This is actual process death/restart at the external-result/Host-commit boundary, not a simulated exception inside one Host.

After evidence, closed only panes in the explicitly created named test session and stopped only `nailong-accept-20261011`. User's default session and production bot remained untouched.
