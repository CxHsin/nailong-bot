---
status: accepted
---

# 移植上游 Akasha 核心并独立管理 Embedding

2026-10-20，用户在[设计结论 #267](https://github.com/CxHsin/nailong-bot/issues/267)确认接入上游 Akasha 的语义检索、图关联与学习能力，并明确选择将核心移植为 TypeScript。上游固定基准为 [94027a5cce9fc494f20bb7931fddf26f1e15e8df](https://github.com/kachofugetsu09/akashic-agent/tree/94027a5cce9fc494f20bb7931fddf26f1e15e8df)，移植须保留 MIT 许可并验证相同输入下的行为等价性。此决定调整 [ADR-0012](0012-layered-memory-and-stable-context.md) 中本地词项与中文双字匹配、不复用图内核的实现选择，不将仅增加向量排序视为完整接入。

曾考虑由 Node 管理上游 Python 工作进程，以降低算法偏差；用户选择 TypeScript 移植，使引擎继续由当前语言与运行环境承载，代价是需要承担移植与对照验证责任，不能将重新实现自动视为上游行为等价。来源、默认遗忘、快照、档案及 Durable 执行事实继续遵循现役职责。

Embedding 使用独立的本地服务与模型配置列表，Telegram 提供选择、状态和连接测试，选择由 Assistant Service 共用并持久保存，凭据留在本机。主模型与路由模型继续使用 Magpie；本次本机目录未发现 embedding 候选，不为提供统一菜单而假定 Magpie 已有该能力。首页合并模型入口，子菜单提供主模型、路由模型及 Embedding 模型。

后台补齐现役历史向量并处理新输入；服务不可用时继续聊天并明确降级。有效原文可检索，历史图学习只使用可验证闭合及输入关联的对话，不补造历史反馈。切换 Embedding 后，新请求使用新模型，历史向量与图在新空间后台重建；空间之间不混用，也不继续调用旧模型。主模型或路由选择不触发记忆重建。

首页模型按钮显示主模型简写，子菜单三项各自显示当前选择；思考等级进入主模型页面，Embedding 页面显示连接、历史处理状态及连接测试。`/model` 无参数进入三项菜单，原带参数的主模型切换用途保留。

完整选择及移植验证边界见[讨论记录](../research/akasha-integration-design-2026-10-20.md)。正式规格为 [Issue #268](https://github.com/CxHsin/nailong-bot/issues/268)，见[本地规格归档](../research/akasha-integration-spec-2026-10-20.md)。本 ADR 和规格不代表代码接入已完成。

## 2026-10-20 实现与证据

当前代码已接入 [TypeScript 核心](../../src/assistant/akasha)、[现役记忆适配](../../src/assistant/akasha-memory.ts)及 [Queue/Durable 学习资格桥](../../src/assistant/akasha-learning.ts)。独立 Embedding 和三项模型菜单沿现役服务控制入口保存选择。图状态与向量属于现役记忆库的派生资料，原文身份、排除关系、查询出处及执行事实仍由各自宿主边界负责；没有生产 Python 工作进程。

原 Python 对照包含 14 次 retrieve/commit、4 次探针、恢复与 6 组直接读出变体，核心 11 项测试通过。分词固定 `@node-rs/jieba@2.0.4`，原 Python 基准为 `jieba==0.42.1`；原生字典的字节顺序及一条重复行有差异，明确进入词法版本。有限样本、拓扑和数值容差对照不能证明任意输入的逐位等价，细节见[夹具说明](../../test/fixtures/akasha/README.md)。

2026-10-20 已经正式 `assistantEnvironment` 在独立临时现役 namespace 使用阿里云 `text-embedding-v3` 生成真实 1024 维向量，并核对跨措辞召回的最终模型请求材料、来源角色/时间/身份及 reopen 复用；聊天响应来自受控 HTTP 端点。定向结果、完整集成检查及两轴审查，以及未执行的生产重启、Telegram 发信与手机观察，统一见[Akasha 接入验收](../akasha-integration-acceptance-20261020.md)。上述实现证据不把设计决定本身当作完成证明。

同日实际召回诊断发现宿主先展开图来源再统一截取消息数，会挤掉已有直接证据。修复沿固定上游 `select_hits` 的两通道选择方式：限额按经历计算，直接通道最多五个，图通道去重后独立限额；选择完成后各通道按开始时间及 UTF-8 身份倒序展示。无闭合原文继续使用既有 SourceFeaturePool 的 dense/BM25 宿主适配，不声称其直接分数等同上游纯 dense Turn 排序。自动材料按实际剩余总字节为两通道保留正文，并优先呈现主命中，来源成员不争夺经历名额。旧输入已保存材料仍按原契约复用，遗忘过滤继续有效。诊断及新增失败回归见[验收补记](../akasha-integration-acceptance-20261020.md#召回通道修复补记)。
