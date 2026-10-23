---
status: accepted
---

# 移植上游 Akasha 核心并独立管理 Embedding

Akasha 语义检索、词项特征、图关联、因果学习与读出核心移植为 TypeScript，上游固定为 [94027a5cce9fc494f20bb7931fddf26f1e15e8df](https://github.com/kachofugetsu09/akashic-agent/tree/94027a5cce9fc494f20bb7931fddf26f1e15e8df)，保留 MIT 许可。相比 Node 管理 Python 进程，移植使引擎沿用当前运行环境，代价是承担行为对照责任；有限对照不证明任意输入的逐位等价，仅增加向量排序也不构成完整移植。

Embedding 使用独立本地配置与服务级持久选择，凭据留在本机；主模型和路由模型继续使用 Magpie。该决定不假定 Magpie 具有 Embedding 能力。切换后新请求使用新模型，历史向量与图在新空间后台重建，空间不混用，也不继续调用旧模型；主模型或路由选择不触发记忆重建。

现役历史在后台补齐，服务故障时保留聊天及词项降级。有效原文可检索，图学习仅使用 Queue/Durable 事实可验证闭合且关联真实输入的经历，不补造历史反馈。自动召回以实际输入保存并复用材料，包括空结果或降级结果；直接命中与图命中分别保留有界名额及正文预算。宿主负责来源、排除关系、查询出处和执行事实。

档案维护使用持久草稿、恢复任务和应用回执承载提炼重试、并发叠加、合并及容量维护。显式图反馈来自真实成功记忆工具结果及闭合经历，后台维护不生成强化信号。[ADR-0012](0012-layered-memory-and-stable-context.md)的稳定快照、默认遗忘及 Durable 职责，以及 [ADR-0015](0015-system-context-order-and-self-file.md)的 SELF 权威性继续有效；本项替代原仅本地词项召回的实现选择。

依据：[结论 #267](https://github.com/CxHsin/nailong-bot/issues/267)、[规格 #268](https://github.com/CxHsin/nailong-bot/issues/268)、[维护 #278](https://github.com/CxHsin/nailong-bot/issues/278)与[反馈 #279](https://github.com/CxHsin/nailong-bot/issues/279)。模型菜单、连接和维护操作见[操作说明](../personal-agent-operations.md)。固定对照及局限见[夹具说明](../../test/fixtures/akasha/README.md)，验证见[接入验收](../akasha-integration-acceptance-20261020.md)及[维护验收](../akasha-memory-maintenance-acceptance-20261020.md)。

历史过程与被替代表述见[整理前版本](https://github.com/CxHsin/nailong-bot/blob/f5351ca4b03a43e589e34e61b1abc402f16dcf1b/docs/adr/0017-port-akasha-engine-and-independent-embedding.md)。
