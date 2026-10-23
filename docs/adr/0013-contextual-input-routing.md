---
status: accepted
---

# 按上下文识别输入意图，由持久队列执行路由

路由模型结合当前输入及回复关系、近期交流和实际工作，提出有序的请求、补充、取消或澄清动作；程序复核目标最新状态并按持久记录执行。采用工作上下文，是为了理解指代和已有工作的区别，代价是分类延迟、上下文预算及状态复核。该决定局部替代 [ADR-0011](0011-durable-main-agent-and-conversation-queue.md)原显式 `/steer` 用户入口，补充通过自然语言关联目标；无关请求仍按 FIFO。

会话没有先前未完成工作、主执行轮次或未交付 helper 时，保留原文并直接交给主助手；存在相关工作时在队首处理阶段判断。已完成、取消或已交付的历史本身不触发分类。分类失败或需要视觉理解时，原身份、附件及未判定原因交回同一个主助手。

路由决定、原输入与动作投递进度关联保存。取消尽快发起对应中断并核实实际停止，未知外部效果先对账；模型判断不覆盖执行事实，也不触发盲目重派。路由模型按 [ADR-0016](0016-magpie-catalog-and-conversation-settings.md)使用 Magpie 目录，选择属于整个 Assistant Service，每次判断开始时冻结；生产入口已结束独立路由别名配置职责。

依据：[结论 #214](https://github.com/CxHsin/nailong-bot/issues/214)、[规格 #215](https://github.com/CxHsin/nailong-bot/issues/215)、[触发范围调整 #238](https://github.com/CxHsin/nailong-bot/issues/238)及[目录扩展规格 #260](https://github.com/CxHsin/nailong-bot/issues/260)。操作见[操作说明](../personal-agent-operations.md)，验证分别见[路由验收](../contextual-input-routing-acceptance-20261016.md)和[目录接入验收](../nailong-persona-acceptance-20261020.md)。

历史过程与被替代表述见[整理前版本](https://github.com/CxHsin/nailong-bot/blob/f5351ca4b03a43e589e34e61b1abc402f16dcf1b/docs/adr/0013-contextual-input-routing.md)。
