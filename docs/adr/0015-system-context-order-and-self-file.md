---
status: accepted
---

# 基础指令由环境配置提供，SELF 文件维护身份并按代生成快照

系统内容按基础指令、skills、项目指令、SELF 快照、MEMORY 快照排列，具体恢复状态等动态材料追加到后续输入。简短基础指令由环境配置提供，SELF 文件作为身份、人设、相处方式及关系理解的权威来源，结束数据库导出覆盖 SELF 的职责；这便于直接编辑，代价是需要协调文件与来源、版本及遗忘元数据。

身份与基础人设由用户明确决定，关系理解和表达习惯可以依据真实交流更新；当前纠正优先，历史理解不产生新授权。SELF 沿用 [ADR-0012](0012-layered-memory-and-stable-context.md)同代快照固定、普通变化立即追加、压缩或 reset 后归并及遗忘立即失效的策略，实际执行状态仍由 Durable 保存。

服务重启加载最新基础规则与人工编辑的 SELF，保留历史及工作进度；运行期间外部编辑在写入边界检查冲突，暂不引入热加载。文件与元数据更新中断时先核对实际文件，避免旧数据库覆盖人工内容。

依据：[结论 #233](https://github.com/CxHsin/nailong-bot/issues/233)、[规格 #234](https://github.com/CxHsin/nailong-bot/issues/234)。本项调整 0012 原 SELF 权威来源及系统布局，其余职责保留。操作见[操作说明](../personal-agent-operations.md)，协议、生命周期与故障证据见[系统与 SELF 验收](../system-self-acceptance-20261017.md)。

历史过程与被替代表述见[整理前版本](https://github.com/CxHsin/nailong-bot/blob/f5351ca4b03a43e589e34e61b1abc402f16dcf1b/docs/adr/0015-system-context-order-and-self-file.md)。
