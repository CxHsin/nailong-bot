---
status: accepted
---

# 主助手使用 Pi Durable，输入由 nailong 会话队列调度

nailong 自有持久队列负责输入路由、去重、会话选择与调度，Pi Durable 负责主助手的模型、工具步骤和执行恢复。每次只向执行器提交当前 Processing Turn，以免取消当前执行时撤销其他等待输入；这复用已有恢复能力，代价是维护队列与执行器之间的交接及未知外部效果核实。

同级独立请求按 FIFO 处理，直接用户输入高于后台事件。轮次结束或会话空闲时选取已排队连续普通输入的有限快照，保留身份、边界与顺序，不为合批等待时间窗。补充与取消的识别由 [ADR-0013](0013-contextual-input-routing.md)决定，替代原显式 `/steer` 用户入口。

主助手可在委派后结束轮次，帮手结果作为内部材料接回；重启按已登记的真实身份核查，复用已确认成果。意外中断可恢复，明确暂停跨重启保留；未知效果先核实。继续操作限定到明确目标，只有一项暂停批次时才可省略选择。重置上下文保留工作与委派，工作恢复不把历史输入变成新指令或追加授权。

本地服务协调这些事实，不建立通用 Task 结算或权限框架，也不承诺跨系统 exactly-once 或外部效果回滚。发送回执与用户目标完成分别判断，未知发送不自动重试。操作、执行权限与重试参数见[操作说明](../personal-agent-operations.md)。旧入口与数据的退役边界见 [ADR-0014](0014-retire-legacy-code-and-data.md)。

依据：[结论 #200](https://github.com/CxHsin/nailong-bot/issues/200)、[规格 #201](https://github.com/CxHsin/nailong-bot/issues/201)、[恢复范围修正 #256](https://github.com/CxHsin/nailong-bot/issues/256)。实现与验证见[切换验收](../durable-assistant-acceptance-20261015.md)及[真实链路测评](../durable-assistant-live-20261016.md)。

历史过程与被替代表述见[整理前版本](https://github.com/CxHsin/nailong-bot/blob/f5351ca4b03a43e589e34e61b1abc402f16dcf1b/docs/adr/0011-durable-main-agent-and-conversation-queue.md)。
