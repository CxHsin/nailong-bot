---
status: accepted
---

# Runtime owns presented work context

2026-10-13，[设计结论 #188](https://github.com/CxHsin/nailong-bot/issues/188) 与[规格 #189](https://github.com/CxHsin/nailong-bot/issues/189)修正主会话的版本与执行边界：Runtime 关联实际呈现的工作身份和要求，Host 校验并保存业务状态，模型理解要求、执行工作并判断成果。模型不填写内部要求版本；收到更新与更新进入模型请求分别记录，工具轮次结束后呈现补充要求，未呈现更新不能被旧完成意图结算。呈现回执只证明上下文关联，不证明模型语义复核正确。

本地交互使用启动目录作为新会话默认工作目录，提示、项目指令与执行工具共享该目录；Session 持久目录单独管理。已保存会话和 Task 的目录、执行模式在重开时保留。本地交互默认 full access，主动选择的受限模式及其他入口保持各自授权边界。这替代 [ADR-0008](0008-personal-agent-orchestration-direction.md) 对所有入口默认受限的方向；full access 继承启动账户的实际权限，工作目录不是沙箱，用户当前指令仍约束工作范围。

工具错误直接返回模型，由模型恢复或正常解释结果。普通回答与失败解释无需独立报告协议或成果清单；普通回复结束不自动完成业务 Task。明确的整体完成意图仍关联当前要求及必要证据，Host 的取消、未知效果、资源占用、预算与 Delivery 事实继续保留。

当前继续使用 Pi 原生执行内核。Pi Durable 后续独立验证，再决定其承接的执行与恢复职责；业务 Task 是用户交办的工作，Durable task 是执行状态机。旧 Runtime Event Log 的持久事实与投影分离思路相近，但旧重启策略不是完整 durable execution，本轮不恢复旧在线内核。
