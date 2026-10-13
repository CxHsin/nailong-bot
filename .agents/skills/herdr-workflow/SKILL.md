---
name: herdr-workflow
description: 通过 herdr CLI 委托单个 Codex 或 Claude 编码帮手，查询、停止、验收并接回成果；用于 nailong 主会话的编码委托。
---

# herdr 编码委托

由主会话读取本 skill，通过现有 `bash` 工具直接调用 herdr。此路径不使用固定 `HerdrExecutor` / `delegate_work` 编码入口；其他任务继续使用现有委派能力。herdr 服务和 CLI 是底层工具。当前 Host 对同一工作只允许一个未结算动作；每轮只发一个 Shell/写入工具调用，等回执后再发下一条。并行派发被拒绝时，先核对上一动作结果和工作状态，不把尚在执行误报为遗失结果。

## 准备

1. 明确项目、目标、验收条件和专用 herdr 具名会话。先核对当前工作有效的 Work Permission；Shell 执行需要可信本机权限。`working_agreements` 中的项目约定可查看、修改和撤销，但约定、skill 加载及 `executionTool:true` 都不授予执行权限。沿用当前工作已有效的授权，缺失时通过 `work_permission` 提案与用户确认取得授权。
2. 选择当次明确指定 > 项目工作约定 > 已有全局默认 > Codex。模型与推理设置沿用所选 CLI 本机配置；明确覆盖时使用该版本支持的参数。指定 agent、模型或模式不可用时报告受阻。保持全局配置原样。
3. 在授权的项目中，Codex 启动参数使用 `--sandbox danger-full-access --ask-for-approval never`，Claude 使用 `--permission-mode auto`。仅处理该项目已授权的启动信任提示。可信模式继承本机权限，项目边界是行为约定；发布、合并 main、外发和越界动作需相应明确授权。
4. 查询 `herdr --version`、`herdr --help` 和将使用的子命令 `--help`，以本机版本为准。诊断预期可能不存在的 pane/workspace/路径时，保存命令输出与真实退出码再判断，避免串联命令因预期缺失中止而丢掉后续对账证据。每次调用带 `--session <专用会话>`；先查 session/workspace/agent，确定没有本任务遗留运行。查询失败或 unknown 保留现场并报告，不能据此重新派发。

## 工作区与启动

核对项目 Git 状态。未提交改动是否纳入需先询问用户；默认以已提交的 `development` 为基准，在授权位置创建本任务独立 worktree。记录基准 SHA、路径、workspace/pane/agent 标识。新 checkout 执行 `npm run hooks:install`。

本项目要求实质改动在 `development` 验证、提交和推送。独立 worktree 可准备补丁，但帮手不在临时分支提交；本体验收后接回 `development`。main 合并等待用户明确同意。依照项目 AGENTS.md 安排集成前同步 main，保留用户已有改动。

本机 CLI 的命令形状如下；从创建与查询回执取得真实 ID，再替换占位符：

```text
herdr --session SESSION worktree create --cwd PROJECT --branch BRANCH --base development --path WORKTREE --no-focus
herdr --session SESSION workspace get WORKSPACE_ID
herdr --session SESSION agent start AGENT_NAME --kind codex --pane PANE_ID --timeout 30000 -- --sandbox danger-full-access --ask-for-approval never
herdr --session SESSION agent get AGENT_NAME
```

Claude 启动替换 `--kind claude` 和上述 Claude 参数。`agent start` 成功表示同一终端检测到预期 agent 且可输入；阻塞时先读终端并处理已授权信任提示，重新核对就绪。Windows 新终端可能缺少桌面应用临时加入的 Codex PATH；启动前在 pane 中核对可执行文件位置，必要时仅为本任务 pane 补 PATH。桌面版 Codex 若提示没有完整本地包，先核对该版本 `--help` 与 `--no-daemon` 支持，再使用本地无 daemon 模式；不安装或切换模型来绕过指定配置。回执区分请求与实际可核实的 agent、模型、目录和权限，无法核实项标明未知。

## 完整传递与等待

将完整任务保存为授权目录内 UTF-8 文件：目标、约束、验收命令、基准与工作目录、允许修改范围、成果路径、禁止自行提交的项目规则。文件是验收依据，不把多行中文任务插入 shell 命令字符串。

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

主会话查看真实 diff、产物与帮手记录，运行约定检查并记录结果和测试条数。权限、数据迁移、核心流程变更或用户要求时增加独立评审。验收不通过最多返工两轮；仍失败则报告缺口，保留现场。

通过后将成果接回 `development`，核对未覆盖用户工作，运行相关验证，按项目提交规范提交和推送，再继续整体目标。仅转发帮手结论不算完成。

停止指定帮手时先核对专用 session 与本任务 pane 的真实身份，使用 `herdr --session SESSION pane close PANE_ID`，再查询 pane/agent 及进程证据。退出、按键或关闭回执不能单独证明进程树已停止；无法核实则报告未知，保留成果，避免另起重复任务。

成果验收并成功接回后，核对 worktree 无未接回成果，按本机 help 使用 `worktree remove --workspace WORKSPACE_ID` 清理本任务 checkout；最后一个 pane 关闭后 workspace 可能已消失，此时核对已记录的 checkout 路径和成果，再使用原仓库的 `git worktree remove PATH` 清理，不能仅凭 agent 消失宣布 worktree 已清理；失败、待决定或停止未知时保留现场。清理范围只限本任务，不停止主服务。

中断后从记录的 session/workspace/pane/agent、prompt 和成果路径查询实际状态，核对已产生影响后接续。直接 Shell 路径没有旧执行器的外部进程账本、跨重启自动恢复和 Host 统一停止保证。真实主 Session 闭环验收由 #179 负责；#180 验收通过后才退役旧执行器，本 skill 的配置成功不代表闭环已通过。
