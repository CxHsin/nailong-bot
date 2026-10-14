# Windows CLI 预检与桌面 Codex 适配

在 `agent start` 前执行。

## 2026-10-14 实测问题与处理

2026 年 10 月 14 日，Telegram 发起真实 Codex 编码任务时，herdr pane 报找不到 `codex` 命令。当天核对发现，Codex 桌面应用已附带可运行的 `codex.exe`（版本 `0.162.0-alpha.17.2`），但 pane 未继承桌面应用临时加入的 PATH；因此无需另下载 CLI。主会话中 `where.exe codex` 成功，不能证明 pane 能找到它。

处理：动态发现可执行路径，将所在目录仅补入目标 pane 的 PATH，并用带 `--no-daemon` 的命令启动桌面 Codex。真实编码任务完成，帮手和主助手分别运行测试，均为 2/2 通过。`--no-daemon` 绕过共享后台服务，命令发现仍由 PATH 解决。完整证据见[实机测试记录](../../../../docs/pi-assistant-live-20261014.md)。以下步骤固化这次处理方案。

## 1. 核对 pane 中的 CLI

先确认目标 pane 是空闲 PowerShell，按真实 session/pane ID 调用：

```text
herdr --session SESSION pane run PANE_ID "Get-Command codex -CommandType Application; codex --version"
herdr --session SESSION pane read PANE_ID --source recent-unwrapped --lines 100
```

`pane run` 的回执只证明命令已发送；读回实际路径、版本与错误后才判断。Claude 将上述 CLI 名称替换为 `claude`。其他 shell 使用其环境语法；正在运行交互 agent 的 pane 先核对状态，Shell 命令只发到空闲 Shell。

若缺失或解析到错误版本，在主会话用 `Get-Command codex -CommandType Application` / `where.exe codex` 查找，选择已核对的可执行文件；两边都找不到时报告安装或启动账户配置缺口。路径随安装版本发现，保留 CLI 模型与全局设置。

## 2. 仅补目标 pane 的 PATH

主会话能找到正确 Codex、pane 找不到时，将下面脚本保存为任务输出目录的 `prepare.ps1`。Pi Bash 通过 `pwsh -NoProfile -File 'D:/授权输出目录/prepare.ps1' -Session SESSION -PaneId PANE_ID` 调用，避免 Bash 提前展开 `$env:PATH`。若主会话有多个版本，先核对 `Get-Command` 所选版本。

```powershell
param([Parameter(Mandatory)][string]$Session,
      [Parameter(Mandatory)][string]$PaneId)
$ErrorActionPreference = 'Stop'
$cliPath = (Get-Command codex -CommandType Application -ErrorAction Stop).Source
$cliDirectory = Split-Path -Parent $cliPath
$paneCommand = '$env:PATH = ' + "'" + $cliDirectory.Replace("'", "''") + ";'" +
    ' + $env:PATH; (Get-Command codex -CommandType Application).Source; codex --version'
& herdr --session $Session pane run $PaneId $paneCommand
if ($LASTEXITCODE -ne 0) { throw 'pane PATH 命令发送失败，保留现场并读回' }
```

再 `pane read`，核对真实解析路径与 `$cliPath` 一致、版本命令成功；输出尚未出现时有界等待并读回。只有确认后才启动 agent。该赋值只修改此 pane 的 Shell 环境；新 pane 重新预检。

## 3. 桌面 Codex 的本次启动适配

在已核对的 pane 中运行 `codex --help` 并读回。使用桌面应用附带的 CLI 时，若本版本帮助列出 `--no-daemon`，在首次启动就将它追加在 `agent start` 的 `--` 后，沿用上述实测成功的组合：

```text
herdr --session SESSION agent start AGENT_NAME --kind codex --pane PANE_ID --timeout 90000 -- --sandbox danger-full-access --ask-for-approval never --no-daemon
```

`--no-daemon` 让本次 Codex 绕过共享后台服务。独立安装的常规 CLI 沿用主 skill 的原命令；启动报错时先读原始终端，版本不支持该参数时按实际帮助选择启动方式并记录。

启动后用 `agent get` / `agent read` 核对真实就绪、目录、模型与权限。PATH 或适配失败仍服从主 skill 的启动重试上限，保留路径发现、终端与回执作为证据。
