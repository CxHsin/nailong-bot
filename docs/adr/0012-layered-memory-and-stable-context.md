---
status: accepted
---

# 分层记忆与稳定活动上下文分开维护

长期记忆采用有原话依据的常驻档案、主题浮现及 Akasha 原文召回，保留主动搜索；当前纠正优先。主助手统一写入共享记忆，helper 只提交候选；压缩后从原始对话后台提炼，明确要求记住、纠正或忘记时立即处理。召回材料是历史证据，其相关性不证明当前有效性或行动权限；Durable 与外部证据决定执行事实。

同一压缩代的实际记忆快照持久固定，重启可复用；普通变化通过追加材料即时生效，压缩或 reset 后归并，以控制缓存前缀变化。遗忘优先于缓存，相关快照、摘要及自动召回材料立即失效。SELF 的文件权威性与系统顺序由 [ADR-0015](0015-system-context-order-and-self-file.md)调整；召回引擎与档案维护扩展由 [ADR-0017](0017-port-akasha-engine-and-independent-embedding.md)决定。

档案按种类、主题、项目及事实内容去重，同一原话可支持多个不同事实。快照和主题的来源引用只用于追溯，不代表原文已完整进入活动上下文；预算省略、仅提供读取引用或仅提炼部分事实的来源仍可自动召回。原文召回仅对实际已在活动上下文中的原输入去重，并继续遵守纠正、遗忘与逐输入材料复用规则。

长工具结果保存持久原件，活动上下文保留受限视图与分页引用。已知引用直接读取，缺失引用时检索调用元数据及归档位置；索引由程序维护，不另建执行流水。压缩保留近期原文及目标、约束、决定原因、进度和下一步，执行细节按需找回。先沿用原生容量触发及后台压缩，空闲压缩收益另测。

高成本且产生大量中间材料的独立子任务使用 helper 上下文，同一子任务复用同一 helper，回传必要结论与来源；轻量工作直接处理。此选择限制主上下文增长，不预设总费用降低。

依据：[结论 #207](https://github.com/CxHsin/nailong-bot/issues/207)、[规格 #208](https://github.com/CxHsin/nailong-bot/issues/208)。操作与预算见[操作说明](../personal-agent-operations.md)，原实现验证见[上下文验收](../context-management-acceptance-20261016.md)，新增召回能力见 [Akasha 验收](../akasha-integration-acceptance-20261020.md)。

历史过程与被替代表述见[整理前版本](https://github.com/CxHsin/nailong-bot/blob/f5351ca4b03a43e589e34e61b1abc402f16dcf1b/docs/adr/0012-layered-memory-and-stable-context.md)。
