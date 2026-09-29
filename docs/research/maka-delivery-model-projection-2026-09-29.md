# Maka：外部 Bot 送达与模型上下文投影

调研日期：2026-09-29。核对 Apache Maka 主线提交 [`ec324da4f578cc111de2a1d2a20444c63432a365`](https://github.com/apache/maka/tree/ec324da4f578cc111de2a1d2a20444c63432a365)。范围是其 Runtime 模型历史投影和桌面端外部 Bot（含 Telegram）入口；以下结论不应外推到所有其他客户端或未公开的部署。

## 结论

**Maka 的现有 Bot 路径没有把外部消息的成功、失败或未知送达状态加入 ModelContextProjection。**它先运行并完成会话 Turn，再尝试发送 Bot 回复。模型重放从会话的 Runtime events 选取已定稿且模型可见的内容；没有以 Bot 送达确认为门槛。发送失败时，Bot 入口尝试发送一条临时失败提示，但没有把“未送达”回写成供模型历史投影消费的事实。因而 Maka 支持“保留模型生成的回答”这一半做法，**不支持把‘未确认送达事实也交给模型’归为 Maka 现有实现**。

## 证据链

1. [Bot 入口](https://github.com/apache/maka/blob/ec324da4f578cc111de2a1d2a20444c63432a365/apps/desktop/src/main/bot-incoming-main.ts#L307-L321)以同一个 `sessionId` 调用 `sessions.runTurn`，并把回复快照交给 Bot reply stream。随后它[等待 Turn 返回，再调用 `replyStream.finish` 或 `botRegistry.sendMessage`](https://github.com/apache/maka/blob/ec324da4f578cc111de2a1d2a20444c63432a365/apps/desktop/src/main/bot-incoming-main.ts#L349-L376)。发送调用之后没有向 `sessions` 回报发送结果。
2. [失败分支](https://github.com/apache/maka/blob/ec324da4f578cc111de2a1d2a20444c63432a365/apps/desktop/src/main/bot-incoming-main.ts#L377-L385)在 `sent` 为假时尝试发一条五分钟后过期的“已生成回复但通道无法发送”提示。它没有把原回答从 Runtime 历史中删除，也没有添加模型可见的送达状态事件。[BotSessionAdapter 接口](https://github.com/apache/maka/blob/ec324da4f578cc111de2a1d2a20444c63432a365/apps/desktop/src/main/bot-session-adapter.ts#L27-L48)只提供创建、准备、运行 Turn 和最佳努力快照回调，没有回复送达回调。
3. [旧 Turn 的上下文构建](https://github.com/apache/maka/blob/ec324da4f578cc111de2a1d2a20444c63432a365/packages/runtime/src/prior-run-context.ts#L49-L74)从 Runtime Event Store 读取先前调用的已提交事件，然后用 `buildRuntimeEventModelReplayPlan` 判断是否有可回放项目；这里没有查询 Bot 消息发送结果。[当前 Turn 后续模型步骤](https://github.com/apache/maka/blob/ec324da4f578cc111de2a1d2a20444c63432a365/packages/runtime/src/ai-sdk-turn.ts#L1370-L1408)也从 Runtime events 构造同一种 replay plan 并转为 provider messages。
4. [模型历史投影](https://github.com/apache/maka/blob/ec324da4f578cc111de2a1d2a20444c63432a365/packages/runtime/src/model-history.ts#L890-L1017)跳过 `partial`、`modelVisibility: hidden` 等事件，并把符合条件的 `role: model` 文本转为 assistant item；[文本项列表](https://github.com/apache/maka/blob/ec324da4f578cc111de2a1d2a20444c63432a365/packages/runtime/src/model-history.ts#L1231-L1263)也按这个角色映射形成。该筛选没有 Bot 送达条件。原文是否逐字保留仍可能受压缩和模型预算处理影响。

## 对本项目问题的回答

Maka 的先例是：**模型生成的已结算文本可以继续作为模型历史，即使外部 Bot 回复随后发送失败。**Maka 当前代码没有提供“已生成但未确认送达”的显式模型上下文说明，也没有看到将 Bot 送达的明确失败与结果未知分开投影给模型的实现。这两项若用于本项目，是本项目自己的设计决策，不能说是照搬 Maka。

本结论来自上述调用链和投影源码的静态核对；未对 Telegram 故障进行端到端注入测试，也不能据此证明 Maka 在所有异常边界上都能完整保留最终模型文本。
