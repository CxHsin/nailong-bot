---
name: herdr-workflow
description: 通过 herdr CLI 委托 Codex 或 Claude 进行只读勘察或代码修改，等待、验收并接回成果；用户指定外部帮手或工作需要独立上下文时使用。
---

# herdr 帮手工作流

由主会话读取本 skill，通过现有 `bash` 工具直接调用 herdr。此路径不使用固定 `HerdrExecutor` / `delegate_work` 编码入口；其他任务继续使用现有委派能力。herdr 服务和 CLI 是底层工具。当前 Host 对同一工作只允许一个未结算动作；每轮只发一个 Shell/写入工具调用，等回执后再发下一条。并行派发被拒绝时，先核对上一动作结果和工作状态，不把尚在执行误报为遗失结果。

## 先选择工作方式

- **只读勘察、架构梳理、代码评审、研究**：普通 `workspace create --cwd PROJECT --no-focus`，直接读取当前目录；不建 worktree、不切分支、不安装 hooks。当前文件（包括未提交改动）就是默认勘察对象，不询问是否纳入；需要对比某个提交时按用户指定读取。报告说明检查的目录和基准，不能把当前目录说成已提交的 development 快照。
- **修改代码**：独立 worktree，以 development 为基准，按下面的修改流程接回成果。只有这个分支才需要询问未提交改动是否纳入任务起点。
- 用户已经明确指定 herdr/Codex/Claude 时直接落实；其他任务按工作量和独立上下文需求判断。上述工作区选择由任务性质决定，不作为每次派发的确认问题。目标或范围不明确时再询问。

## 准备

1. 明确项目、目标和验收条件；本体选择或生成本任务的 herdr 会话及唯一 agent 名称，不要求用户决定这些内部标识。先核对当前工作有效的 Work Permission；Shell 执行需要可信本机权限。`working_agreements` 中的项目约定可查看、修改和撤销，但约定、skill 加载及 `executionTool:true` 都不授予执行权限。沿用当前工作已有效的授权，缺失时通过 `work_permission` 提案与用户确认取得授权。只读勘察仅申请项目读取范围；prompt、传递脚本和报告写入当前工作已有的输出目录，不申请项目写权限。声明帮手只读、不修改项目。可信执行下这是行为约定，不是只读沙箱。代码勘察本身不需要网页访问，但外部 CLI 连接模型服务可能需要网络，按实际执行依赖填写，不能因为“只读”便宣称 CLI 无需网络。
2. 选择当次明确指定 > 项目工作约定 > 已有全局默认 > Codex。模型与推理设置沿用所选 CLI 本机配置；明确覆盖时使用该版本支持的参数。指定 agent、模型或模式不可用时报告受阻。保持全局配置原样。
3. 在授权的项目中，Codex 启动参数使用 `--sandbox danger-full-access --ask-for-approval never`，Claude 使用 `--permission-mode auto`。仅处理该项目已授权的启动信任提示。可信模式继承本机权限，项目边界是行为约定；发布、合并 main、外发和越界动作需相应明确授权。
4. 核对本机版本；新命令、语法不确定、报错或生命周期状态不明确时查对应 `herdr <cmd> --help`，以 CLI 为准，不在每个任务重复读取全部帮助。诊断预期可能不存在的 pane/workspace/路径时，保存命令输出与真实退出码再判断，避免串联命令因预期缺失中止而丢掉后续对账证据。每次调用带 `--session <专用会话>`；先查 session/workspace/agent，确定没有本任务遗留运行。查询失败或 unknown 保留现场并报告，不能据此重新派发。

## 工作区与启动

按工作方式创建 workspace，记录路径与 workspace/pane/agent 标识。只读任务使用原目录，保存原有 Git 状态，报告结束后核对没有新增项目改动；已有脏工作区不妨碍读取，不提交或清理用户改动。

以下 Git 集成规则只用于修改代码：核对项目 Git 状态，未提交改动是否纳入先询问用户；以已提交的 development 为基准创建独立 worktree，并记录基准 SHA。本项目新 checkout 执行 `npm run hooks:install`。

本项目要求实质改动在 `development` 验证、提交和推送。独立 worktree 可准备补丁，但帮手不在临时分支提交；本体验收后接回 `development`。main 合并等待用户明确同意。依照项目 AGENTS.md 安排集成前同步 main，保留用户已有改动。

本机 CLI 的命令形状如下；从创建与查询回执取得真实 ID，再替换占位符：

```text
# 只读勘察：直接打开当前目录
herdr --session SESSION workspace create --cwd PROJECT --label LABEL --no-focus
# 修改代码：才创建独立 worktree
herdr --session SESSION worktree create --cwd PROJECT --branch BRANCH --base development --path WORKTREE --no-focus
herdr --session SESSION workspace get WORKSPACE_ID
herdr --session SESSION agent start AGENT_NAME --kind codex --pane PANE_ID --timeout 30000 -- --sandbox danger-full-access --ask-for-approval never
herdr --session SESSION agent get AGENT_NAME
```

Claude 启动替换 `--kind claude` 和上述 Claude 参数。`agent start` 成功表示同一终端检测到预期 agent 且可输入；阻塞时先读终端并处理已授权信任提示，重新核对就绪。Windows 新终端可能缺少桌面应用临时加入的 Codex PATH；启动前在 pane 中核对可执行文件位置，必要时仅为本任务 pane 补 PATH。桌面版 Codex 若提示没有完整本地包，先核对该版本 `--help` 与 `--no-daemon` 支持，再使用本地无 daemon 模式；不安装或切换模型来绕过指定配置。回执区分请求与实际可核实的 agent、模型、目录和权限，无法核实项标明未知。

## 完整传递与等待

将完整任务保存为授权目录内 UTF-8 文件：目标、约束、基准与工作目录、成果路径。只读任务写明不修改项目、读取当前未提交内容、报告需要引用的文件与证据；代码修改任务另写允许修改范围、验收命令和禁止自行提交的项目规则。文件是验收依据，不把多行中文任务插入 shell 命令字符串。

Pi 的 `bash` 默认使用 Bash；在 Windows 需要 PowerShell 时，通过 `pwsh -NoProfile -File 'D:/授权目录/本任务.ps1'` 调用任务内脚本。脚本用参数数组和 `Get-Content -LiteralPath -Raw -Encoding utf8` 传递 prompt，检查每条原生命令退出码；不要假定 `AGENT_SHELL_PATH` 已是 PowerShell。

```powershell
$ErrorActionPreference = 'Stop'
$session = '已核对的专用会话'
$agent = '已核对的帮手名称'
$promptPath = 'D:/授权目录/task-prompt.txt'
$taskPrompt = Get-Content -LiteralPath $promptPath -Raw -Encoding utf8
& herdr --session $session agent prompt $agent $taskPrompt --wait --until working --timeout 5000
if ($LASTEXITCODE -ne 0) { throw '派发未确认，先查询和读回，保留 prompt 文件' }
```

`prompt` 本机只接收 TEXT 参数，以上避免 Bash/PowerShell 两层插值。提交前确认 agent 就绪且没有旧轮次工作；`--wait` 不跟踪独立轮次，已 working 的旧轮次可能被误当作新轮次。结合终端读回核对本任务已接收；未确认接收、超时或 stalled 时先查询，避免盲目重复发送。

用 `agent wait AGENT_NAME --timeout 30000` 内置等待，随后 `agent get` 与 `agent read AGENT_NAME --source recent-unwrapped --lines 200` 读取状态和输出。尚在运行时继续有界等待并向用户报告必要进展。超时仅表示未等到状态；idle/done 只是观察，不等于验收。

## 验收、接回与停止

只读任务由主会话核对报告中的实际文件、引用和结论，并检查项目未新增改动；接回报告继续用户目标，不要求修改、测试、提交、推送或切换到 development。代码修改任务由主会话查看真实 diff、产物与帮手记录，运行约定检查并记录结果和测试条数。权限、数据迁移、核心流程变更或用户要求时增加独立评审。验收不通过最多返工两轮；仍失败则报告缺口，保留现场。

代码修改验收通过后将成果接回 `development`，核对未覆盖用户工作，运行相关验证，按项目提交规范提交和推送，再继续整体目标。仅转发帮手结论不算完成。

停止指定帮手时先核对专用 session 与本任务 pane 的真实身份，使用 `herdr --session SESSION pane close PANE_ID`，再查询 pane/agent 及进程证据。退出、按键或关闭回执不能单独证明进程树已停止；无法核实则报告未知，保留成果，避免另起重复任务。

只读报告验收接回后，保存报告并关闭本任务创建的 pane/workspace，保留原项目目录及用户文件。代码修改成果验收并成功接回后，核对 worktree 无未接回成果，按本机 help 使用 `worktree remove --workspace WORKSPACE_ID` 清理本任务 checkout；最后一个 pane 关闭后 workspace 可能已消失，此时核对已记录的 checkout 路径和成果，再使用原仓库的 `git worktree remove PATH` 清理，不能仅凭 agent 消失宣布 worktree 已清理；失败、待决定或停止未知时保留现场。清理范围只限本任务，不停止主服务。

中断后从记录的 session/workspace/pane/agent、prompt 和成果路径查询实际状态，核对已产生影响后接续。直接 Shell 路径没有旧执行器的外部进程账本、跨重启自动恢复和 Host 统一停止保证。真实主 Session 闭环验收由 #179 负责；#180 验收通过后才退役旧执行器，本 skill 的配置成功不代表闭环已通过。
