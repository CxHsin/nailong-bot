---
status: accepted
---

# 基础指令由环境配置提供，SELF 文件维护身份并按代生成快照

2026-10-17，用户在[系统内容与 SELF 讨论](../research/system-context-self-decisions-2026-10-17.md)中逐项确认下述方向，结论发布为 [Issue #233](https://github.com/CxHsin/nailong-bot/issues/233)：将系统内容按基础指令、skills、项目指令、SELF 快照、MEMORY 快照排列，固定规则靠前，具体恢复状态等动态材料追加到后续输入。`.env` 承载简短基础指令，不再单独维护 `system-prompt.md`；SELF 文件成为身份、人设、相处方式与关系理解的权威来源，结束数据库导出覆盖 SELF 的职责。

选择文件权威性便于用户直接修改身份内容，代价是后续实现须衔接来源、版本、纠正、遗忘及旧数据，不能让数据库与文件互相覆盖。身份与基础人设由用户明确决定；助手可以依据真实交流更新关系理解和表达习惯。当前纠正优先，历史理解不成为新的用户授权。

SELF 沿用同一压缩代固定快照、普通变化立即追加、压缩或 reset 后归并的策略；遗忘立即使相关派生材料失效。服务重启让已有会话采用最新基础规则与人工编辑的 SELF，保留历史及工作进度，暂不增加热加载。实际执行状态继续由 Durable 保存。

## 实施状态

正式规格为 [Issue #234](https://github.com/CxHsin/nailong-bot/issues/234)，见[本地规格归档](../research/system-context-self-spec-2026-10-17.md)。

实现按 [#234](https://github.com/CxHsin/nailong-bot/issues/234)接入现役 Assistant Service：环境入口校验 `AGENT_SYSTEM_PROMPT`，公开 section API 按 base、skills、project、self、memory 排列；已有 root 通过 configure 清除旧 instructions。`SELF.md` 保存当前正文及条目依据，SQLite 保存来源、版本、排除、快照和变更；运行期间外部编辑在写入边界报冲突，服务重启才重新加载。文件 rename 后元数据中断时停止后续自动使用，重开按实际文件核对，避免旧数据库覆盖。

普通写入保留冻结快照并投递增量；纠正或遗忘剔除受影响片段，不顺带归并无关新增内容。SELF/MEMORY 合计受常驻预算限制。现役旧生成档案迁移有效条目，人工修改优先，缺失文件只在首次初始化使用有效旧条目和既定奶龙默认值；初始化后的文件缺失须恢复后再启动。

本项局部调整 [ADR-0012](0012-layered-memory-and-stable-context.md)中基础人设、SELF 权威来源与系统布局的方向，其余记忆、归档和 Durable 边界保留。[本次验收](../system-self-acceptance-20261017.md)记录协议编码、生命周期、持久化故障及真实模型证据；实现提交不代表生产服务已重启。
