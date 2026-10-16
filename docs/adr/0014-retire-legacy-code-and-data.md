---
status: accepted
---

# 清退旧实现与遗留数据，保留现役助手职责

2026-10-17，用户确认保留现役 Personal Agent 的能力，清退已被替代的实现与本地遗留数据。结论为 [Issue #225](https://github.com/CxHsin/nailong-bot/issues/225)，正式规格为 [Issue #226](https://github.com/CxHsin/nailong-bot/issues/226)，另有[本地规格归档](../research/legacy-retirement-spec-2026-10-17.md)。

旧离线诊断、旧日志迁移，以及从旧 Pi 会话导入 helper 身份的职责结束；实施时移除相应入口、专用依赖、配置和只验证退休职责的测试。选择结束这些兼容职责，是为了让已经退出生产的旧日志、记忆与上下文实现可以完整退役，代价是不再通过当前 checkout 读取或恢复旧系统资料。仍被当前入口调用的共享能力和仍适用于现役行为的回归保证保留。

旧记忆、事件日志、投影、工具原件、旧会话及确认遗留的原型和备份由本次维护直接物理删除，不新增备份或归档。该决定结束本次清理范围内旧数据的保留；旧数据未受 Git 跟踪，删除后不承诺恢复。删除前核对实际使用者和确切绝对路径，不能由文件名或所在目录推定其已退休。

[ADR-0011](0011-durable-main-agent-and-conversation-queue.md)、[ADR-0012](0012-layered-memory-and-stable-context.md)及[ADR-0013](0013-contextual-input-routing.md)规定的现役队列、Durable Workflow、路由、Delegation、共享记忆、Akasha Recall、Memory Snapshot、Tool Archive 与发送回执继续保留。结束旧 helper 导入不清除现役空间中已有的 helper 身份与控制记录。默认现役空间 data/pi-durable-v1 完整保留，实际配置、凭据和独立成果也不纳入旧资料清理。

此次是有明确范围的一次性维护，不增加启动自动删除或定期清理。当前文档随实现更新；历史 ADR、研究和验收保留原基准，涉及被删源码时改用经核对的提交永久链接。

## 实施状态

本 ADR 记录已确认的退役决定；规格发布时尚未删除代码或本地数据。实施须分别交付源码验证、实际删除清单和现役资料保留的证据；不能由提交或规格状态推导生产服务已切换。
