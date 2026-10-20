---
status: accepted
---

# 移植上游 Akasha 核心并独立管理 Embedding

2026-10-20，用户在[设计结论 #267](https://github.com/CxHsin/nailong-bot/issues/267)确认接入上游 Akasha 的语义检索、图关联与学习能力，并明确选择将核心移植为 TypeScript。上游固定基准为 [94027a5cce9fc494f20bb7931fddf26f1e15e8df](https://github.com/kachofugetsu09/akashic-agent/tree/94027a5cce9fc494f20bb7931fddf26f1e15e8df)，移植须保留 MIT 许可并验证相同输入下的行为等价性。此决定调整 [ADR-0012](0012-layered-memory-and-stable-context.md) 中本地词项与中文双字匹配、不复用图内核的实现选择，不将仅增加向量排序视为完整接入。

曾考虑由 Node 管理上游 Python 工作进程，以降低算法偏差；用户选择 TypeScript 移植，使引擎继续由当前语言与运行环境承载，代价是需要承担移植与对照验证责任，不能将重新实现自动视为上游行为等价。来源、默认遗忘、快照、档案及 Durable 执行事实继续遵循现役职责。

Embedding 使用独立的本地服务与模型配置列表，Telegram 提供选择、状态和连接测试，选择由 Assistant Service 共用并持久保存，凭据留在本机。主模型与路由模型继续使用 Magpie；本次本机目录未发现 embedding 候选，不为提供统一菜单而假定 Magpie 已有该能力。首页合并模型入口，子菜单提供主模型、路由模型及 Embedding 模型。

后台补齐现役历史向量并处理新输入；服务不可用时继续聊天并明确降级。有效原文可检索，历史图学习只使用可验证闭合及输入关联的对话，不补造历史反馈。切换 Embedding 后，新请求使用新模型，历史向量与图在新空间后台重建；空间之间不混用，也不继续调用旧模型。主模型或路由选择不触发记忆重建。

首页模型按钮显示主模型简写，子菜单三项各自显示当前选择；思考等级进入主模型页面，Embedding 页面显示连接、历史处理状态及连接测试。`/model` 无参数进入三项菜单，原带参数的主模型切换用途保留。

完整选择及移植验证边界见[讨论记录](../research/akasha-integration-design-2026-10-20.md)。本 ADR 记录已确认设计，尚未发布最终规格或完成代码接入。
