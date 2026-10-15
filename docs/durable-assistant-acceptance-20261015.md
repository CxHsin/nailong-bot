# 持久队列与主 agent 工作流验收（2026-10-16）

规格 [#201](https://github.com/CxHsin/nailong-bot/issues/201)，实现 [#202](https://github.com/CxHsin/nailong-bot/issues/202)、[#203](https://github.com/CxHsin/nailong-bot/issues/203)、[#204](https://github.com/CxHsin/nailong-bot/issues/204)、[#205](https://github.com/CxHsin/nailong-bot/issues/205)。本文件记录正式 Assistant Service、Telegram/CLI 入口的实际验收；[独立 Pi Durable 实验](research/pi-durable-integration-2026-10-15.md)与[旧原生 Session 验收](pi-assistant-acceptance-20261014.md)保留各自范围，不能代替本轮证据。

状态：2026-10-16 已完成实现与受控综合验收。受检范围为基准 `769249c` 后、本记录所在提交的源码与测试；正式入口代码已切换，尚未启动真实模型/Telegram/helper 的生产联调。

## 行为与证据对应

| 保证 | 需要观察的事实 | 当前证据 |
| --- | --- | --- |
| 完整接收与去重 | 接收确认后强杀保留正文/图片/顺序；同源身份一次、同文异身份分别处理 | `assistant-queue`：正文、图片、原身份和批次强杀恢复；`assistant-runtime`：真实成果跨重启去重 |
| 会话隔离、FIFO 与合批 | 同会话不并发，其他会话可推进；A 后 B/C 合批、D 后续；不跨命令/来源/优先级屏障 | `assistant-queue`、`assistant-controls`：实际输入顺序、并发门闩和固定批次边界 |
| steer | 仅显式补充；连续身份/顺序、工具边界、最终答复边界、空闲转普通、空命令 | `assistant-controls`、`assistant-durable`、`assistant-service-recovery`：模型实际看到补充一次，接收后强杀仍可消费 |
| 抢占与续接 | 直接输入抢占后台，同级不抢占；旧工作按新指令继续/调整/结束，成果不重复 | `assistant-queue`：抢占接收后强杀、原工作身份与 reconcile 材料；`assistant-durable`：已确认成果复用。策略由主 agent 结合最新指令决定；受控模型不证明真实模型的业务判断质量 |
| 队列与执行器交接 | 接收、领取、提交、保存 submission、步骤完成、批次确认前后强杀重开，不丢失或盲重交 | `assistant-queue`：received/claimed/submitted/effect 四处强杀；`assistant-durable`：SDK admission 成功但尚未保存 ID 时强杀，不提供 submissionId 也能按原 requestKey 找回同一提交，原输入/效果各一次；`assistant-service-recovery`：正式服务在工具确认、输出交付、steer 接收处强杀，实际工具成果只产生一次 |
| 重试与暂停 | 最多 4 次模型请求，执行器单层重试；暂停通知一次、其他输入可处理，重启不绕过暂停 | `assistant-retry`、`assistant-durable`：实际 HTTP 请求数、错误分类、退避中强杀和暂停跨重启；`assistant-runtime`：抢占续接后台合计 4 次，重启仍暂停，明确 resume 后才有新预算 |
| 工具结果与未知效果 | 已确认结果复用；未决工具分别核实完成/未执行/无法核实；不把任意 Shell 视作 safe | `assistant-durable`：真实子进程 unsafe 效果强杀，三种核实结论及顺序多工具阻断；`assistant-telegram`：模拟远端已接收文件后断线，新 callId 重发被阻止，实际交付次数为 1，回执可关联文件和调用 |
| reset | 上下文清理，保留事件、执行进度、委派及必要恢复材料 | `assistant-controls`、`assistant-interaction`、`assistant-runtime`、`assistant-durable`：命令屏障、历史不回注、确认工具成果复用及 helper 回传跨 reset |
| herdr 内部结果 | 原身份接回、不重派；先落盘、用户输入优先、内部交付一次、不直接向通道发送 | `assistant-runtime`、`assistant-queue`、`assistant-namespace`：用可观察 herdr 客户端核对原 session/agent/pane/workspace，原回传只读取一次，排队直接输入先处理 |
| 模型与通道兼容 | 模型配置、指令/skills/MCP、图片/文件/草稿、鉴权/回执、CLI 选会话 | `assistant-runtime`、`assistant-interaction`、`assistant-telegram`、`assistant-cli` 及连接器回归：受控 HTTP 模型、真实文件及 grammY API 替身；未访问真实服务 |
| 新空间切换 | 拒绝旧空间，新会话空白；只核对旧委派身份，不删除旧目录或伪造执行回执 | `assistant-namespace`、`assistant-interaction`：旧索引/孤立 session 指针拒绝，旧 helper 原身份只读衔接，旧历史标记不进入模型输入，旧文件逐一保持原内容 |

## 综合检查

全部实现与评审修复停写后执行：

- `npm run typecheck`：通过。
- `npm test`：全仓 128 项通过，0 失败、0 跳过，含子测试，约 64 秒。该总数包含保留的旧日志/离线诊断回归，不全部属于新执行器。
- `npm run build`：通过。
- `npm run docs:check`：76 篇跟踪文档、227 个本地链接通过。
- `git diff --cached --check`：通过。

强杀恢复使用真实子进程和同一持久存储，断言实际模型输入/输出、工具调用次数与成果，不以状态文案代替。模型请求使用本地受控 HTTP 服务，Telegram 使用 grammY API 替身，herdr 使用可观察客户端替身；本轮没有向真实用户发送消息，也没有派发真实外部帮手。

真实模型、真实 Telegram 客户端及真实外部 helper 的证据单列，受控模型和 API 替身不能证明其质量或实际送达。未知效果不承诺自动撤销；本次不覆盖断电持久性、跨系统 exactly-once、cron/邮件/Slack、herdr 内部恢复与完整记忆。

## 评审修复

以 `769249c` 为实施基准完成 Standards 与 Spec 两轴审查。以下缺陷已加入回归，去掉相应修复会失败：

- 旧 helper JSON 损坏导致启动失败时，队列锁未释放；修复前同进程修正数据后仍无法启动。
- 后台工作自动抢占续接重置预算；修复前后台请求为 5 次，回归要求最多 4 次，只有明确 resume 才有新预算。
- 文件远端接收后连接断开，模型换新 callId 再发；修复前交付 2 次，回归要求 1 次并暂停核实。
- 同一顺序工具轮中，首个 unsafe 操作中断后，后续副作用早于核实执行；移除 `beforeTool` 的恢复扫描后，核实前副作用为 1 次，回归要求 0 次。

首次全量还发现 Git hooks 测试复制整个实验目录时将 `node_modules` 带入临时仓库；夹具现仅复制 hooks 实际依赖的两个脚本，继续验证真实分支保护与暂存空白检查。
