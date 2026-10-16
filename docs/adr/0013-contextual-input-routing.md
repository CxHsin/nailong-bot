---
status: accepted
---

# 按上下文识别输入意图，由持久队列执行路由

2026-10-16，用户确认采用独立快速模型，结合当前消息及回复关系、近期对话和实际工作列表，识别输入的动作与目标，再由程序按确定规则路由。[设计结论 #214](https://github.com/CxHsin/nailong-bot/issues/214)是[正式规格 #215](https://github.com/CxHsin/nailong-bot/issues/215)的依据，[讨论记录](../research/intent-aware-input-routing-2026-10-16.md)保留逐轮确认，规格另有[本地归档](../research/contextual-input-routing-spec-2026-10-16.md)。

此决定替代 [ADR-0011](0011-durable-main-agent-and-conversation-queue.md)中普通输入不隐式补充、必须使用 `/steer` 的约束：自然语言补充关联当前、排队或后台 helper 工作，移除用户输入入口 `/steer`。无关请求仍按 FIFO；取消尽快发起对应中断并核实实际停止。耗时工作继续由 herdr helper 在后台执行，主 Bot 处理后续输入。合批保留各条消息的身份和独立目标，不等待固定时间窗。

选择带工作上下文的判断，而非直接照搬只读最新文字的模型选择分类器，是为了理解“刚才那个”等指代及正在执行、排队和后台工作的区别。代价是额外判断延迟、上下文预算及目标状态复核；模型只负责理解，实际执行记录决定动作能否实施。分类失败或需要视觉理解时，原始用户输入通过普通队列交回同一个主 Bot，并单独附带未判定原因，保留原身份与附件。

保留现有持久队列、Pi Durable 和 herdr 的职责及恢复保证，关联保存原输入、路由决定与投递进度。执行前核对目标最新状态；未知外部效果按已有对账规则处理，不盲目重派或重复投递。

## 实现状态

实现任务 [#216](https://github.com/CxHsin/nailong-bot/issues/216)–[#219](https://github.com/CxHsin/nailong-bot/issues/219) 在 development 实现独立分类、稳定目标与有序动作、持久调度、helper 控制及 Telegram 回复关联，退役用户 `/steer` 入口。当前验证与真实链路缺口见[路由验收记录](../contextual-input-routing-acceptance-20261016.md)，不由本 ADR 推导部署状态。未配置分类别名时保留原文兜底；原 Durable 目录兼容升级，不清空队列、补充或委派记录。
