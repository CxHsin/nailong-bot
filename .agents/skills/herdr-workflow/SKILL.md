---
name: herdr-workflow
description: 通过 herdr CLI 委托 Codex 或 Claude 进行只读勘察或代码修改，等待、验收并接回成果；用户指定外部帮手或工作需要独立上下文时使用。
---

# herdr 帮手工作流

主会话通过原生 Pi Shell 派发外部帮手，登记后台观察，接回后检查实际成果并继续用户目标。herdr 是底层终端工具。

## 0. 兜底规则

官方 skill 在 `~/.agents/skills/herdr-official/SKILL.md`，可用时读取。新命令、语法不确定、报错或生命周期不明时查对应 `herdr <cmd> --help`，以实际安装版本为准；无需每次读取全部帮助。

- `idle` 表示就绪，`done` 是工作完成后的 idle，`blocked` 是审批或提问，`unknown` 无法分类。状态、完成标记和 prompt 回显都只是观察，实际成果由主会话验收。
- 普通等待用 `agent wait`；等特定状态才用 `--until`。普通终端命令可用 `pane run` / `pane wait-output --match`；读结果优先 `recent-unwrapped`。
- 使用专用 session 与唯一 agent 名称，记录 workspace/pane、执行目录、基准、prompt 和成果路径。workspace/pane/agent 命令带 `--session SESSION`；session 管理命令按对应 help 调用（本机 `session attach NAME` 不接受全局 `--session`）。查询失败或 unknown 时保留现场、先对账。
- 先核对专用 session 是否运行。`session attach` 是持续前台客户端，不作为普通同步 Shell 命令等待退出；需要启动时按本机帮助在后台运行。Windows 任务脚本使用 `Start-Process -WindowStyle Hidden`，记录本任务客户端 PID 与日志，再查询 session 确认就绪。客户端与 server 分别核对，保留其他会话及主服务。
- 诊断命令保存原生命令输出和真实退出码再判断；预期失败可由任务脚本捕获并明确报告，不能把管道后续命令的退出码当作 herdr 成功，也不能因 Shell 返回成功而忽略回执中的错误。

## 1. 打开 workspace（修改才用 worktree）

先明确目标仓库、范围和验收；目标不清楚时询问用户。用户已经指定帮手时按指定执行。

**只读勘察、评审、研究**直接读取当前目录，包括未提交内容；保存原始 Git 状态，不询问是否纳入脏改动，不切分支、不装 hooks、不创建 worktree。报告标明实际目录与比较基准。

**修改代码**先读目标仓库说明，询问未提交改动是否纳入（已有明确答复直接沿用），再创建隔离 worktree。基准和成果接回方式服从目标仓库规则；没有说明时以当前分支为基准，记录 SHA。已同意纳入的改动须完整保留，接回时核对用户工作。

```text
# 只读：原目录普通 workspace
herdr --session SESSION workspace create --cwd PROJECT --label LABEL --no-focus
# 修改：BASE 来自目标仓库规则；无规则时来自当前分支
herdr --session SESSION worktree create --cwd PROJECT --branch BRANCH --base BASE --path WORKTREE --no-focus
herdr --session SESSION workspace get WORKSPACE_ID
herdr --session SESSION pane list --workspace WORKSPACE_ID
```

从真实回执取得 ID。

## 2. 启动 agent（90 秒，最多两次重试）

配置按当次明确指定 > 项目约定 > 全局默认 > Codex 选择。模型与推理继承所选 CLI 配置；需要覆盖时按该版本帮助传参。保持 CLI 全局默认原样；指定配置不可用时报告受阻。

Windows 启动前先按 [Windows CLI 预检与桌面 Codex 适配](references/windows-startup.md) 核对 pane 内的可执行路径；需要时补该 pane 的 PATH，并确认当前版本是否适用 `--no-daemon`，再执行下面的启动命令。

```text
herdr --session SESSION agent start AGENT_NAME --kind codex --pane PANE_ID --timeout 90000 -- --sandbox danger-full-access --ask-for-approval never
# Claude 用 --kind claude，CLI 参数替换为 --permission-mode auto
herdr --session SESSION agent get AGENT_NAME
herdr --session SESSION agent read AGENT_NAME --source recent-unwrapped --lines 200
```

初次失败先读终端，处理已授权的项目信任或就绪提示，核对是否已存在同名 agent、实际进程和状态，再决定是否重试；初次之后最多两次启动重试，每次等待 90000 毫秒。仍无法就绪则报告受阻并保留现场，不更换指定配置，也不通过修改全局默认绕过提示。

记录请求配置和实际可核实的可执行路径、agent、模型、目录、权限及启动适配参数；无法核实项写明未知。

## 3. 从文件传递 prompt

将完整任务保存为已有授权输出目录中的 UTF-8 文件，包含目标、工作目录、目标仓库约束、允许范围、成果路径和验收。只读任务明确读取当前未提交内容、引用真实文件、不修改项目；修改任务写明接回方式和约定检查。可请求独立完成标记作为辅助证据。

发送前查询 agent 并读终端，确认已经就绪、没有旧任务混淆。`agent prompt --wait` 不绑定独立轮次；旧 working 状态可能误报新任务接收。

Pi Shell 默认 Bash；Windows 下把传递放在任务内 PowerShell 脚本，通过 `pwsh -NoProfile -File 'D:/授权输出目录/send.ps1'` 调用。prompt 不插入多层 Shell 命令字符串：

```powershell
$ErrorActionPreference = 'Stop'
$session = '已核对的专用会话'
$agent = '已核对的帮手名称'
$taskPrompt = Get-Content -LiteralPath 'D:/授权输出目录/task-prompt.txt' -Raw -Encoding utf8
$promptArgs = @('--session', $session, 'agent', 'prompt', $agent, $taskPrompt,
    '--wait', '--until', 'working', '--timeout', '5000')
& herdr @promptArgs
if ($LASTEXITCODE -ne 0) { throw '接收未确认：先查询状态和读终端，保留 prompt' }
```

结合终端读回确认本任务已接收；超时、stalled 或 Shell 等待被中断时先查 `agent get` 和 `agent read`，不盲目重发。参数形状随安装版本帮助核验。

## 4. 等待、读结果、验收和清理

### Pi 主助手的后台接回

确认本次 prompt 已接收后，调用 `herdr_watch`，填写从真实回执取得的 `session`、`agent`、`paneId`、`workspaceId`、实际 `cwd` 和本次 `promptPath`。登记成功后结束当前工具轮次、及时回应主人；等待由桥接在后台执行。桥接只观察已派发的帮手，服务重启先核对实际身份与状态，不重新启动工作。

`herdr_result` 是带身份的外部执行材料。收到后按本节独立验收，不把 idle/done 当成果成功。blocked 或 unknown 时核对原终端，保留现场，向主人说明所需决定；恢复工作后观察继续。登记失败时先读回实际状态，避免重复派发。

主人插话时先判断归属：无关交流直接回应，明确的编码补充要求转交相应帮手，无法判断先询问。明确停止时查实际帮手和 pane，按当前 CLI 帮助停止并核对进程；终端关闭或状态未知不证明已停止。补充要求与停止不撤销已有影响。

### 有界查询与成果核对

```text
herdr --session SESSION agent wait AGENT_NAME --timeout 30000
herdr --session SESSION agent get AGENT_NAME
herdr --session SESSION agent read AGENT_NAME --source recent-unwrapped --lines 200
```

用内置 wait 等待；仍在运行时继续有界等待并报告必要进展。超时不表示失败或停止，idle/done 不表示验收通过。长等待可放任务内后台脚本并保存日志，主会话接续时读回实际状态。

主会话独立验收：只读核对报告的文件引用、结论和原始 Git 状态，确认项目无新增修改；修改核对真实 diff、新产物与执行记录，运行约定检查、记录结果和测试条数。完成标记、帮手自评、旧验收记录不能替代本次证据。失败给出具体缺口，最多返工两轮，仍失败报告缺口并保留现场。

通过后按目标仓库规则接回修改或报告，继续完整用户目标。保存本次 prompt、终端结果、验收证据及成果后，只清理本任务创建的资源：核对 pane 身份再 `pane close`，必要时按 help 关闭 workspace；修改任务成功接回且没有遗漏成果后按 help 执行 `worktree remove --workspace WORKSPACE_ID`。workspace 已消失时核对记录的 checkout 和成果，再从原仓库 `git worktree remove PATH`。用户文件和原项目目录保持完整。

失败、待决定或停止未知时保留现场。关闭回执不证明进程树停止，需查询 pane/agent 并核对进程证据；不能核实时报告未知，避免重复启动。不得停止 herdr 主服务。

## 5. 多阶段接力

耦合且全部已授权、无中途检查点的阶段写入一个 prompt。分阶段或不同帮手使用任务内 relay 脚本与内置 waits，逐阶段独立验收后才推进。承诺继续接力时要实际安排 wait 或脚本，不能只承诺盯着；未经授权的阶段在检查点停止。

以下每阶段调用一次的 relay 片段由主会话填入已经核对的 session、agent 和本阶段文件，前提是第 3 节的就绪检查已完成。不同阶段可以使用不同帮手；脚本只负责派发、等待和读回，主会话是验收闸门。

```powershell
param([string]$Session, [string]$Agent, [string]$PromptPath)
$ErrorActionPreference = 'Stop'
$taskPrompt = Get-Content -LiteralPath $PromptPath -Raw -Encoding utf8
& herdr --session $Session agent prompt $Agent $taskPrompt --wait --until working --timeout 5000
if ($LASTEXITCODE -ne 0) { throw '接收未确认，先查询与读回' }
& herdr --session $Session agent wait $Agent --timeout 30000
if ($LASTEXITCODE -ne 0) { throw '等待未确认，保留现场并核对状态' }
& herdr --session $Session agent read $Agent --source recent-unwrapped --lines 200
if ($LASTEXITCODE -ne 0) { throw '读回失败，保留现场' }
```

每次脚本返回后，主会话查询实际状态；blocked/unknown 或仍在工作时先对账或继续内置 wait。阶段 settled 后按第 4 节核对真实报告、diff、产物与约定检查：

1. 通过：记录阶段验收证据，立即对下一已授权阶段调用脚本；遇到未授权检查点则停下等待。
2. 失败：写入包含具体缺口的返工 prompt，核对就绪后对同一阶段再调用；最多两轮返工，仍失败报告缺口、保留现场，后续阶段不推进。
3. Shell 中断：先核对实际进程、已产生影响和成果再接续，不把截断当作取消，也不自动重复派发。

这是一份任务内脚本和主会话闸门，不新增后台任务框架或自动恢复保证。

## 6. 执行与交付

本 skill 由原生 Pi 资源加载器发现，配置见[能力说明](../../../docs/capabilities.md)。文件与 Shell 使用启动账户权限，工作目录不是沙箱。依据当前交办范围和目标仓库指令执行；主会话无需填写权限有效期或提交成果结算表单。

只读任务在已有输出目录保存 prompt、脚本和报告，保留项目原状。Codex full access / Claude auto 继承本机权限，项目只读和目录范围是行为约定。发布、外发、重要删除、越界动作及合并须有对应授权。

主会话检查实际文件、差异和执行记录后正常回复；用 `send_file` 发送主人要求的本地产物。在线发布先核对授权。中断后从记录的 session/workspace/pane/agent、prompt、成果与验收证据对账；桥接负责恢复观察，不承诺跨重启自动完成所有工作或统一停止外部进程。

## 上游对照

基线：[上游 herdr-workflow](https://github.com/joyehuang/skills/blob/master/personal/herdr-workflow/SKILL.md)（2026-10-13 读取；规格 #183）。

- **保留**：0–5 的兜底、workspace/worktree 分流、启动、文件 prompt、读回清理和接力结构；内置 wait、主会话验收、最多两轮返工、只清理自己的资源与本地保留成果。
- **适配**：目标仓库决定基准与集成；只读包含脏改动；启动 90 秒且仅两次重试；CLI 配置继承、Windows pane/PATH 与 PowerShell 文件传递；Pi 可信执行、后台观察与按目标交付（规格 #196）。
- **省略**：作者固定模型、永久权限默认设置及私有 `task_protocol.py` registry/runner、notifier、watchdog、签收与恢复协议、`publish-artifact`/R2 发布设施；不复制这些依赖，也不声称它们的保证。
