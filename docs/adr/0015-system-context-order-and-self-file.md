---
status: accepted
---

# 基础指令由环境配置提供，SELF 文件维护身份并按代生成快照

2026-10-17，用户在[系统内容与 SELF 讨论](../research/system-context-self-decisions-2026-10-17.md)中逐项确认下述方向，结论发布为 [Issue #233](https://github.com/CxHsin/nailong-bot/issues/233)：将系统内容按基础指令、skills、项目指令、SELF 快照、MEMORY 快照排列，固定规则靠前，具体恢复状态等动态材料追加到后续输入。`.env` 承载简短基础指令，不再单独维护 `system-prompt.md`；SELF 文件成为身份、人设、相处方式与关系理解的权威来源，结束数据库导出覆盖 SELF 的职责。

选择文件权威性便于用户直接修改身份内容，代价是后续实现须衔接来源、版本、纠正、遗忘及旧数据，不能让数据库与文件互相覆盖。身份与基础人设由用户明确决定；助手可以依据真实交流更新关系理解和表达习惯。当前纠正优先，历史理解不成为新的用户授权。

SELF 沿用同一压缩代固定快照、普通变化立即追加、压缩或 reset 后归并的策略；遗忘立即使相关派生材料失效。服务重启让已有会话采用最新基础规则与人工编辑的 SELF，保留历史及工作进度，暂不增加热加载。实际执行状态继续由 Durable 保存。

## 实施状态

正式规格为 [Issue #234](https://github.com/CxHsin/nailong-bot/issues/234)，见[本地规格归档](../research/system-context-self-spec-2026-10-17.md)。

本项是已确认、尚未实现的设计，局部调整 [ADR-0012](0012-layered-memory-and-stable-context.md)中基础人设、SELF 权威来源与系统布局的方向。其余长期记忆、工具归档、来源治理和 Durable 边界保留。现行实现及既有验收仍适用于原基准；本轮只记录设计，不表示环境、数据或运行代码已经迁移。
