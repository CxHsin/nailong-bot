---
status: accepted
---

# 主模型目录由 Magpie 提供，选择归属会话并允许双端修改

2026-10-18，用户确认[设计结论 #242](https://github.com/CxHsin/nailong-bot/issues/242)：主助手只使用 Magpie 的模型目录，经 Magpie Agent 插件接入，替代 `.env` 中逐模型配置和直接连接主模型的入口。供应商、账号及模型目录由 Magpie 管理，Nailong 保存 Conversation 的模型选择和思考偏好。Telegram 和 Magpie 都可修改当前 Telegram 主 Conversation 的模型并回显，以最后一次明确用户修改为准；其他 Conversation 独立保存。目录刷新和重启不得覆盖选择。

采用此边界，是为了让用户在已使用的 Magpie 中统一管理模型来源，并在电脑与手机上调整同一助手；代价是主助手依赖 Magpie 连接及目录元数据，需要验证配置同步和双向回显。保留独立意图识别模型与外部 helper 的原有职责，不把主模型目录迁移扩大为所有调用的统一配置重写。

会话控制面板的查看和设置不等待整个 Processing Turn。新设置在当前模型请求结束后的后续请求使用，不中止当前请求，不重放已确认结果。换模型保留上下文和工作进度，较小窗口沿用原生压缩；仍无法承接则暂停说明。切换暂停工作的模型不自动恢复工作，明确继续时才使用当前选择续接。此决定保留 [ADR-0011](0011-durable-main-agent-and-conversation-queue.md)、[ADR-0012](0012-layered-memory-and-stable-context.md)、[ADR-0013](0013-contextual-input-routing.md) 与 [ADR-0015](0015-system-context-order-and-self-file.md) 的执行、队列、上下文、记忆和系统指令边界。

首版 Telegram 支持按模型调整并保存思考等级；Magpie 的通用 Agent 插件目前只提供模型字段，因此 Magpie 端等级控件延期，以[后续 #243](https://github.com/CxHsin/nailong-bot/issues/243)跟踪上游 PR，不以修改或自编译 Magpie 作为首版前提。面板入口、常用列表、故障反馈和保存规则见[已确认讨论记录](../research/conversation-control-panel-design-2026-10-18.md)。本 ADR 记录设计决定，尚不代表实现或接入验收完成。
