# 架构决定

按任务选择下表中的现役决定。ADR 解释仍生效的职责与取舍；运行方式见[操作说明](../personal-agent-operations.md)，领域定义见 [GLOSSARY](../../GLOSSARY.md)。实现、测试和部署状态到相应验收记录中核对。

| 任务涉及 | 现役决定 | 适用边界与后续关系 |
| --- | --- | --- |
| 输入队列、执行恢复、委派 | [0011：队列与 Pi Durable](0011-durable-main-agent-and-conversation-queue.md) | 输入含义与补充由 0013 决定；恢复指定目标，不隐式恢复全部暂停工作 |
| 记忆、快照、压缩、工具原件 | [0012：分层记忆与稳定上下文](0012-layered-memory-and-stable-context.md) | SELF 权威来源与系统顺序见 0015；召回引擎与维护扩展见 0017 |
| 输入意图、补充、取消 | [0013：上下文路由](0013-contextual-input-routing.md) | 替代 0011 原显式 `/steer` 用户入口；路由模型来源见 0016 |
| 旧实现、旧资料的保留责任 | [0014：遗留职责退役](0014-retire-legacy-code-and-data.md) | 记录一次性退役边界，现役资料与职责继续保留 |
| 基础指令、SELF、系统顺序 | [0015：SELF 权威文件](0015-system-context-order-and-self-file.md) | 调整 0012 原 SELF 权威来源，保留记忆与快照职责 |
| 模型来源、选择、设置生效 | [0016：Magpie 目录与会话设置](0016-magpie-catalog-and-conversation-settings.md) | 主模型按 Conversation 保存，路由模型为服务级选择；Embedding 见 0017 |
| Akasha、Embedding、图学习、档案维护 | [0017：移植 Akasha 核心](0017-port-akasha-engine-and-independent-embedding.md) | 替代 0012 原本地词项召回实现选择，保留来源、遗忘及执行事实边界 |

## 历史决定

0001–0006 记录旧 Context Projection 和重构边界；0007–0009 记录旧 Personal Host/Task 底座；0010 记录原生 Pi Session 入口。它们均已被替代，按需从对应文件、原 Issue 或固定源码提交追溯。现役实现以表中职责为入口，避免把旧架构名词带回新设计。

历史研究及规格位于 [research](../research/)，读取与更新规则见 [domain.md](../agents/domain.md)。
