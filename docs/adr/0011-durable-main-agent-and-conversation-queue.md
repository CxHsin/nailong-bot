---
status: accepted
---

# 主 agent 使用 Pi Durable，输入由 nailong 会话队列调度

设计结论：[Issue #200](https://github.com/CxHsin/nailong-bot/issues/200)。已确认正式规格：[Issue #201](https://github.com/CxHsin/nailong-bot/issues/201)。

2026-10-15，在完成 [9 项接入实验](../research/pi-durable-integration-2026-10-15.md)并澄清现有工具用途后，用户确认采用 Pi Durable 1.2.0 承载主 agent 的持久执行，由 nailong 自有持久队列负责事件路由、去重、会话选择、优先级、同级 FIFO 与合批。[行为结论与规格确认记录](../research/event-queue-durable-workflow-2026-10-15.md)记录完整范围。此决定替代 [ADR-0010](0010-native-pi-assistant.md)中暂缓主 agent 持久工作流与采用原生 steering 接收新输入的方向。

选择 Pi Durable 可复用模型和工具步骤的持久执行能力，避免在旧 SDK 上自建全部工具恢复协议，也无需部署 Temporal 的独立 Service/Worker。代价是 Harness、现有会话和工具接口需要衔接；实验尚未验证所有队列/执行器崩溃交接窗口，亦不提供跨系统 exactly-once 或外部效果回滚保证。

## 队列与执行器的边界

nailong 保留未运行事件，每次只向 Harness 提交当前轮次，避免 Durable abort 撤掉其他等待输入。同级输入按 FIFO 等待；直接用户输入高于后台来源，可抢占低优先级轮次。被抢占工作保留身份和已完成结果，之后结合最新指令判断继续、调整或结束；已 aborted 的执行续接使用新的 submission 关联原事件。

用户在调研后确认：当前轮结束或会话空闲时，读取已经排队的连续普通输入有限快照，按原顺序交给下一轮，不为凑批等待固定时间窗。每条输入保留身份和边界，命令、来源或优先级变化隔开批次，不推断多条消息属于同一目标。Telegram 显式 `/steer 内容` 才用于当前工作的补充，在下一个支持的输入边界按序读取已接收的补充；普通新消息仍按同级 FIFO 等待。`steer` 不等于立即停止工具，也不替代高优先级抢占；需持久保留补充身份以核对重启或 abort 后是否已消费。

主 agent 派发 herdr 后可结束当前轮次；帮手在独立上下文执行，内部返回摘要与证据。保存原委派身份，重启查询并接回结果，不盲目重派。`herdr_watch`、`send_file` 与项目指令/技能能力保留并接入新运行时；迁移后删除旧注册实现，不建设无使用者的通用旧扩展兼容层。

进程重启自动恢复意外中断的队列与执行进度。已确认步骤复用成果，未知外部效果先核实，无法确认则暂停询问；临时基础设施故障有限重试，业务与工具错误交回模型。用户确认模型重试耗尽后保留进度、暂停并通知一次，等待明确继续；其他输入可处理，重启不绕过暂停。`/reset` 只重置主上下文，保留事件、进度与委派；取消另行处理。

用户确认切换时不迁移旧会话历史，新会话从空白上下文开始；这不等于物理删除旧目录或忽略已有外部委派。空闲时 `/steer 内容` 转为普通输入并遵守已有队列顺序，空命令显示用法。

范围为 Windows 本机单服务。cron、邮件、Slack 等连接器、herdr 内部步骤恢复、完整分层记忆和缓存优化留待后续。批次的完成与恢复协议、内部材料投递、默认模型重试上限等细节及完整迁移验收均已整体确认，见[正式规格归档](../research/event-queue-durable-spec-2026-10-15.md)；规格确认不等于生产迁移完成。合批选择依据见[调研记录](../research/personal-agent-message-scheduling-2026-10-15.md)。

## 实现与当前验证

正式入口保留 [Telegram](../../src/main.ts) 与 [CLI](../../src/cli/main.ts)，由 [Assistant Service](../../src/assistant/runtime.ts) 连接应用队列与 Durable 执行器，替代旧原生 Session 注册路径。默认执行空间为 `data/pi-durable-v1`；显式指定的目录也须与旧 Session 数据区分，不导入历史、摘要或工具轨迹。旧外部委派按真实身份衔接，不伪造为 Durable 已执行步骤。

模型临时故障默认最多重试 3 次，含首次共 4 次请求，基础等待 2 秒，仅由执行器一层负责。`/resume [批次ID]` 明确继续本会话暂停的工作，省略 ID 时选择本会话全部暂停项；重启不绕过暂停。`/reset` 保留事件、进度和委派，普通消息排队与显式 `/steer` 各自遵循上述边界。

实现任务 [#202](https://github.com/CxHsin/nailong-bot/issues/202)、[#203](https://github.com/CxHsin/nailong-bot/issues/203)、[#204](https://github.com/CxHsin/nailong-bot/issues/204)、[#205](https://github.com/CxHsin/nailong-bot/issues/205) 已于 2026-10-16 完成受控综合验收：全仓 128 项测试、类型检查、构建及文档链接检查通过。实际输入/输出、强杀恢复证据见[受控验收记录](../durable-assistant-acceptance-20261015.md)；随后完成真实模型、Telegram 手机文件交付及真实 helper 原身份恢复，见[真实链路测评](../durable-assistant-live-20261016.md)。[操作说明](../personal-agent-operations.md)描述新入口，旧验收保留原基准与限制。
