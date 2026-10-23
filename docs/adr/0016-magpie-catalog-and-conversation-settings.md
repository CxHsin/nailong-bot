---
status: accepted
---

# 主模型与路由模型使用 Magpie 目录，分别保存选择

主助手和路由模型共用 Magpie 的连接与目录，结束正式入口的逐模型直连及独立路由别名配置职责；主模型与 thinking 归属各 Conversation，路由模型选择属于整个 Assistant Service。统一来源便于在已有 Magpie 与 Telegram 中管理模型，代价是依赖连接及目录元数据。Embedding 独立配置，见 [ADR-0017](0017-port-akasha-engine-and-independent-embedding.md)。

Magpie Agent 插件只共享 owner 的 Telegram 主 Conversation 模型，双端以最后一次明确用户修改为准；其他 Conversation 独立。刷新、回写回声和重启不覆盖选择。新设置在后续请求准备时生效，当前请求保持已冻结配置，保留上下文与已确认成果；换模型不恢复暂停工作，较小窗口优先采用原生压缩，仍无法承接则暂停说明。

会话设置协调模块负责快照、会话内同步、全会话传播、Durable 配置和同步任务生命周期；runtime 负责路由与队列调度。控制查询等待已登记会话的设置传播，包括等待期间新增的任务，同步失败使查询拒绝；面板操作不等待整个 Processing Turn。目录、设置持久化和请求 checkpoint 各自保留既有责任。

Telegram 保存模型的思考偏好，Magpie 端思考控件仍由[后续 #243](https://github.com/CxHsin/nailong-bot/issues/243)跟踪。路由模型在每次判断开始时冻结服务级选择，切换不重算已有决定。奶龙互动、饱食度及辅助启动招呼的已确认范围见[规格 #260](https://github.com/CxHsin/nailong-bot/issues/260)，操作见[操作说明](../personal-agent-operations.md)。

依据：[结论 #242](https://github.com/CxHsin/nailong-bot/issues/242)、[规格 #244](https://github.com/CxHsin/nailong-bot/issues/244)、[协调规格 #251](https://github.com/CxHsin/nailong-bot/issues/251)及[目录扩展结论 #259](https://github.com/CxHsin/nailong-bot/issues/259)。扩展后的路由目录选择取代原“仅迁移主模型”的范围。模拟、真实接入与手机观察分别见[控制验收](../conversation-control-acceptance-20261018.md)及[互动验收](../nailong-persona-acceptance-20261020.md)。

历史过程与被替代表述见[整理前版本](https://github.com/CxHsin/nailong-bot/blob/f5351ca4b03a43e589e34e61b1abc402f16dcf1b/docs/adr/0016-magpie-catalog-and-conversation-settings.md)。
