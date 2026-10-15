# Pi Durable 接入验证

独立实验，验证版本固定为 `@earendil-works/pi-durable 1.2.0`。当前线上入口不导入这些文件，根项目依赖也未切换。结论见[验证报告](../../../docs/research/pi-durable-integration-2026-10-15.md)。

## 运行

在仓库根目录执行，使用 Node 24，并先安装根项目依赖以提供现有 SDK 和 `tsx`：

```powershell
npm ci
npm ci --prefix scripts/experiments/pi-durable --ignore-scripts --no-audit --no-fund
npm run check --prefix scripts/experiments/pi-durable
```

核心检查不访问付费模型、不派发外部帮手，包含真实子进程强杀/重开和 Windows Shell 进程取消。SQLite、心跳、返回材料和运行结果均写入系统临时目录，结束时打印证据路径；保留这些文件便于检查。可用 `DURABLE_PROBE_OUTPUT` 指定一个新的输出目录。

真实模型检查使用根目录已有 `.env` 配置，会调用每个已配置模型，读取本项目 herdr skill 的开头；没有发送 Telegram 消息：

```powershell
npm run check:live --prefix scripts/experiments/pi-durable
# 只检查一个真实模型，沿用原别名：
node --env-file-if-exists=.env --import tsx scripts/experiments/pi-durable/verify.mjs --live --only-live --alias=gpt
# 只检查实际 Shell 取消：
node --import tsx scripts/experiments/pi-durable/verify.mjs --check=windows-shell-cancellation
```

结果不输出 API key、完整请求或模型推理内容。模型错误的诊断仅保存在本次临时输出目录。模型配置中的价格为零，不将 usage 中的零价格解释成实际费用。

## 代码职责

- `bridge.mjs`：沿用当前模型配置、项目指令/技能发现，以及现有 `herdr_watch` 的小型适配；没有实现通用旧扩展兼容层。
- `worker.mjs`：在子进程中执行工具，在确定的中断位置由父进程强杀，然后重开 SQLite。
- `queue.mjs`：实验所需的单进程应用队列。展示同级 FIFO、优先级和抢占后续接，不是生产队列实现。
- `verify.mjs`：核心检查与可选真实模型检查，断言实际工具结果、调用次数、输入身份和处理顺序。
- `live-herdr.mjs`：对**已确认接收任务**的真实 herdr 帮手进行登记、强杀验证主进程、重开并接回结果。不会派发或重启外部帮手。

## 真实 herdr 检查

按[仓库 herdr-workflow](../../../.agents/skills/herdr-workflow/SKILL.md)派发独立只读任务并确认接收。在仓库外准备：

- `record.json`：`session`、`agent`、`paneId`、`workspaceId`、`cwd`、`promptPath`，均来自真实回执。
- 同目录的 `sample.json`：数字 `left` 和 `right`。
- 帮手实际读取样本后，最终输出 `DURABLE_HELPER_RESULT=<left + right>`。不要在 prompt 中提供答案。

```powershell
node --import tsx scripts/experiments/pi-durable/live-herdr.mjs C:/absolute/new-probe-output/record.json
```

使用新的输出目录，避免旧实验的去重回执和观察记录影响新任务。任务结束后按技能核对、保存终端证据并只清理本任务 pane/workspace。主模型在此项检查中为确定性 fixture，以隔离真实 herdr 桥接；真实付费模型另行验证。

## 验证边界

已完成工具的崩溃恢复与被取消工作的业务续接不同：后者需要新 submission 关联原事件，并重新核对最新指令。实验在抢占状态保存后强杀，没有覆盖应用队列与 Harness 之间的任意崩溃窗口。

旧 Session 导入、图片/文件交付（包括 `send_file`）、Telegram 草稿和回执、连续消息组织与合批、完整 `/reset` 衔接尚未迁移或验收。当前没有发现第三方扩展依赖，不要求建设通用旧扩展兼容层；在用工具的核查见验证报告。不能把本实验直接作为线上替换入口。

本次保存的脱敏结果见 `evidence/`；它们是实际运行证据，不是每次运行自动覆盖的测试快照。
