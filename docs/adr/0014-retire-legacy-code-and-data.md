---
status: accepted
---

# 清退旧实现与遗留数据，保留现役助手职责

2026-10-17 的一次性维护结束旧 Host、旧记忆与投影实现、离线诊断、旧日志迁移和旧 Pi helper 身份导入的职责，同时保留仍被现役入口调用的共享能力与适用保证。结束这些兼容责任使退休实现可以完整移除，代价是当前 checkout 不再读取或恢复旧系统资料。

当次授权清理的旧本地数据直接物理删除，不建立备份或归档；执行前按实际使用者和绝对路径核对。现役数据空间、配置、凭据、独立成果，以及现役空间中已有的 helper 身份与控制记录保留。该授权限定于当次已确认清单，不构成后续清理或启动自动删除的授权。

[队列与执行](0011-durable-main-agent-and-conversation-queue.md)、[记忆与快照](0012-layered-memory-and-stable-context.md)、[路由](0013-contextual-input-routing.md)及发送回执继续承担现役职责。历史 ADR、研究与验收保留原基准，退休源码使用核对过的提交链接；当前说明随实现更新。

依据：[结论 #225](https://github.com/CxHsin/nailong-bot/issues/225)、[规格 #226](https://github.com/CxHsin/nailong-bot/issues/226)。实际清单与当次验证见[清退验收](../legacy-retirement-acceptance-20261017.md)。

历史过程与被替代表述见[整理前版本](https://github.com/CxHsin/nailong-bot/blob/f5351ca4b03a43e589e34e61b1abc402f16dcf1b/docs/adr/0014-retire-legacy-code-and-data.md)。
