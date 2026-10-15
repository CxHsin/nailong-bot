# Pi Durable 接入验证

> 本文保留正式实现前的独立实验环境与 9 项证据。后续队列、执行器和入口切换状态见 [当前验收](../durable-assistant-acceptance-20261015.md)，不将其混算为本实验通过项。

日期：2026-10-15。范围来自[队列与持久工作流讨论](event-queue-durable-workflow-2026-10-15.md)中用户对“先做接入验证，再决定采用”的同意。本次完成实验，没有切换正式入口。实验及工具清理说明后，用户确认采用，见 [ADR-0011](../adr/0011-durable-main-agent-and-conversation-queue.md)。

## 结论

**已确认选用 Pi Durable 承载主 agent 的持久执行，并由 nailong 自有队列负责路由、去重、优先级与 FIFO。** 本机验证表明，模型配置、项目指令/技能、工具恢复及 herdr 观察均存在可行接入路径；它不是现有 coding-agent Session 的透明替代。该选型确认未扩大下述实验覆盖范围。

真实 Windows 环境为 Node `v24.15.0`，独立安装的 `@earendil-works/pi-durable`、`pi-ai`、`chord` 均固定 `1.2.0`，使用 `node:sqlite` 与 Git Bash。根项目原有 `@mariozechner/pi-coding-agent` 和运行入口保持原样。

## 实际结果：9 项通过

| 检查 | 实际观察 |
| --- | --- |
| 不安全工具中断恢复 | 完成第一个工具，第二个工具执行期间强杀进程；重开后第一个工具调用仍为 1 次，第二个未重跑，模型收到 interrupted 结果并能看到第一个工具的完整结果 |
| 安全工具中断恢复 | 相同强杀位置，标记 safe 的第二个工具执行 2 次，覆盖同一文件形成一个逻辑结果；第一个已完成工具仍仅 1 次 |
| 去重、优先级、FIFO 与重启 | 相同 requestId 在强杀前后返回相同 submission；应用队列的重复事件忽略；后台被抢占后强杀重开，处理顺序为 direct-1、direct-2、background-1、background-2 |
| Windows Shell 取消 | 原生 bash 工具实际启动 Node 心跳进程，abort 后 PID 不再存在，心跳停止更新；检查的不只是模型返回取消文本 |
| 项目指令、技能和原生工具 | 复用现有 SDK 的独立加载函数，Durable 模型上下文含 AGENTS 与技能目录，真实 read 读取 herdr skill，真实 bash 返回项目目录 |
| herdr 受控客户端 | 沿用现有 herdr_watch 和 inspectHelper 身份检查，保存后重开、查询同一帮手，零次重新派发；结果通过内部条目提交并去重，没有接 Telegram |
| 真实 Completions 模型 | 沿用配置别名 ds、真实上游模型身份与凭据，模型调用 read 后返回 DURABLE_SKILL_OK herdr-workflow |
| 真实 Responses 模型 | 沿用配置别名 gpt、真实上游模型身份与凭据，同样完成 read 和确认回复 |
| 真实 herdr/Codex 结果接回 | 按 herdr-workflow 派发只读样本任务，帮手实际读取 137 和 284，返回 421；登记已完成帮手后强杀 Durable 主进程，重开按原身份读取并独立确认结果，内部结果仅提交一次，没有重新派发 |

前 7 项（不含独立 Shell 取消与真实 herdr）在最终完整运行中为 **7/7**。Shell 取消 **1/1**，真实 herdr **1/1**，合计 **9/9**；这是独立实验检查数，不是根项目测试套件条数。

脱敏机器结果：[7 项接入结果](../../scripts/experiments/pi-durable/evidence/integration-results-20261015.json)、[Shell 取消](../../scripts/experiments/pi-durable/evidence/shell-cancellation-20261015.json)、[真实 herdr](../../scripts/experiments/pi-durable/evidence/real-herdr-20261015.json)。复现命令与代码入口见[实验说明](../../scripts/experiments/pi-durable/README.md)。结果只保存面向用户的模型文本，没有凭据、完整请求或模型推理正文。

## 必须纳入后续设计的发现

### 抢占需要应用层队列

Durable `abort()` 会终止当前 run 并撤销其内部排队输入。若把所有外部事件提前交进 Durable inbox，高优先级抢占可能撤掉其他等待事件。

实验采用单独持久应用队列，仅将当前事件提交给 Harness，其他事件继续保留。抢占完成后把旧事件标为 suspended；续接使用新的 submission 关联原事件，因为已 aborted 的旧 requestId 不会重新执行。这个方法通过了固定位置的抢占/重启检查，但尚未覆盖队列与 Harness 之间所有崩溃窗口，也未实现最新指令冲突判断。

### 持久执行与未知效果核实

已提交的模型/工具结果可以恢复。中断中的 safe 工具会再次执行，unsafe 工具交回 interrupted；因此任意 Shell 或外部写操作不能一概标记 safe。对外部事实的核实和无法确认时询问用户，仍需应用和工具的具体衔接。

本次验证的是进程强杀，不是断电。当前 SQLite 适配使用 WAL 与 synchronous=NORMAL，不应由进程恢复结果推导断电后最后一次提交必不丢失。

### 后续 `/steer` 静态核查

用户确认 Telegram 显式 `/steer` 才用于运行中补充，普通输入仍排队到后续轮次。对已安装 1.2.0 发布包的补充静态核查表明，接口是 `submit` 的 `whenBusy: "steer"`，不是独立的 `.steer()`。在整轮工具完成后的边界，所选 steer 会加入当前 run；如果模型直接产出最终答复，则在 final 边界结束旧 run、让待处理输入启动后续 run。因此它不提供“立即打断工具”或“必定进入原 run”的保证。[发布包说明](https://unpkg.com/@earendil-works/pi-durable@1.2.0/README.md)、[generation 实现](https://unpkg.com/@earendil-works/pi-durable@1.2.0/dist/harness/generation.js)

`steeringMode: "all"` 可在边界读取全部已排队 steer，各自保留输入条目，并不判断语义是否相同。它不能替代 nailong 的统一优先级与 FIFO 队列。提交和 inbox 有持久记录，但会话 abort 会撤销其中待处理的输入，因此应用仍需保留 `/steer` 原始内容与提交身份，恢复时核对是否已消费。[inbox 实现](https://unpkg.com/@earendil-works/pi-durable@1.2.0/dist/harness/inbox.js)、[提交实现](https://unpkg.com/@earendil-works/pi-durable@1.2.0/dist/harness/submissions.js)、[abort 实现](https://unpkg.com/@earendil-works/pi-durable@1.2.0/dist/harness/scheduler.js)

以上是源码审阅，不新增或扩大前述 9 项实验的覆盖。显式 `/steer` 的通道解析、边界交接、重启去重、abort 续接及空闲处理仍需正式实现与验收。

### 模型和资源需要适配

沿用当前配置的模型身份、端点、凭据和兼容标志可调用新 pi-ai provider，但需显式沿用当前运行时的 thinkingLevel：推理模型使用 low，其他模型 off。第一次 Responses 检查默认 off 时向上游发送 effort=none，被当前 GPT 模型以 400 拒绝；补齐配置后复测通过。

项目指令与技能可通过现有 SDK 的 loadProjectContextFiles、loadSkills、formatSkillsForPrompt 单独加载，再构成 Durable sections，无需开启旧 AgentSession。此结果仅证明指令/技能发现与读取；旧 extension hooks、slash commands、模板和动态资源未获得自动兼容。

### 当前工具与扩展清理

2026-10-15 按用户“有用则保留，无用则删除”的要求核查：当前自有 Pi 注册代码提供两项在用能力，`herdr_watch` 保存帮手身份并观察结果，`send_file` 将文件交给通道发送。迁移时保留这两项能力，改为 Durable 的工具接入方式；无需为它们建设通用旧扩展兼容层。当前入口尚未切换，因此仍保留正在使用的注册实现。

`AssistantOptions.extensionPaths` 仅声明并转交 SDK，没有任何生产、测试或脚本调用者，已删除该参数及转交代码。SDK 的默认资源发现仍负责项目指令、技能及目录资源加载，不能随该参数一并删除。当前本地默认工作目录和数据目录没有发现外部扩展；测试中的 `.pi/extensions/fixture.ts` 是临时夹具。没有发现需要迁移的第三方扩展，因此不把通用旧 hooks、slash commands 等自动兼容列为迁移要求；若后续发现实际使用者，再单独核对。

herdr_watch 复用原有工具实现并转换结果格式。内部回传用带来源身份的自定义条目保存摘要和证据位置，不把完整终端过程塞进主上下文，也不因回传直接发给用户。模型协议中的角色与条目的业务来源需要分别保留。

## 环境问题与证据边界

安装首次遇到 ECONNRESET，有限重试后完成。真实 herdr 首次 pane 无 codex PATH，核对错误后只补充本次 pane 的 PATH，保留全局配置。首次只读任务的等待命令被 Guard 以 MUTABILITY_UNPROVEN 拒绝；取消等待，改成单条静态 Get-Content 后完成样本读取。第一次未确认接收的补充消息仍停在输入框，读回核对后才补 Enter；没有把旧 done 状态当作本次成功。

真实 herdr 的成功登记发生在帮手完成之后，因此证明的是已完成结果的跨进程接回，不把它写成“本次在外部工具运行中强杀后仍继续”的证据。后者已有生产桥接的历史验收，但不能混算成本次结果。

原始运行目录保留于本机临时目录：

- `C:/Users/Cx/AppData/Local/Temp/nailong-pi-durable-nS4OTW/`：最终 7 项完整运行。
- `C:/Users/Cx/AppData/Local/Temp/nailong-pi-durable-dN1a3B/`：实际 Shell 取消。
- `C:/Users/Cx/AppData/Local/Temp/nailong-durable-herdr-live-20261015/`：prompt、样本、终端、失败尝试与 attempt3 成功证据。只清理本次 herdr pane/workspace，保留共享服务与原始证据。

这些临时路径不是仓库外可用的交付；可分享的结果与实验代码已保存在仓库。

## 尚未决定或验证

执行引擎选型已确认；用户后续决定旧会话历史不迁移，新会话从空白开始。普通消息采用轮次边界的已排队有限快照，不主动等待时间窗；显式 `/steer` 才补充当前工作，空闲时转普通输入。重试耗尽保留进度并暂停通知。上述后续决定不是本实验已实现的保证。

路由匹配与去重键、批次恢复、内部结果调度、数据空间切换、完整 reset 与取消衔接，以及 Telegram 图片/文件/草稿/发送回执仍属于正式实现和验收范围，见用户已整体确认的[正式规格归档](event-queue-durable-spec-2026-10-15.md)及权威 [Issue #201](https://github.com/CxHsin/nailong-bot/issues/201)。消息组织选择的研究依据见[后续调研](personal-agent-message-scheduling-2026-10-15.md)。

本次没有接入 cron、邮件或 Slack，没有修改 herdr 内部执行恢复，也没有承诺任意外部副作用精确一次。`herdr_watch`、`send_file` 与当前 Channel 行为须按[迁移评审约定](../agents/refactor-review.md)逐项核对；通过本实验不意味着正式迁移已经完成。
