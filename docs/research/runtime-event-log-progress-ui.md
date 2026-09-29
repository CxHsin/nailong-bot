# Runtime event log 与 Telegram 阶段性进展调研

调研日期：2026-09-29。范围：公开的 Maka 与 Codex 实现/文档，以及本仓库当前代码。这里的“阶段性进展”指像「我发现了什么，接下来要做什么」这样的用户可读说明，而非工具名、参数或输出列表。

## 已确认的事实

### Maka

- Maka 的 [Log Is the Runtime 文章](https://github.com/apache/maka/blob/main/docs/blogs/log-is-the-runtime.md) 把持久化 `RuntimeEvent Log` 当作事实源。事件有 `Text`、`Thinking`、`FunctionCall`、`FunctionResponse`、`Error` 等内容类型，带 `sessionId`、`turnId`、`runId`、`invocationId` 及单调 `event_seq`。文章称 `projectRuntimeEventsToStoredMessages()` 把事件投影为 UI 对话、工具卡片与 turn 状态；模型上下文、终止状态、恢复分别有其他投影。文章讲的是事件与投影架构，不等于每条事件都应展示给用户。
- 直接对应本题的 [Maka 讨论 #4268](https://github.com/apache/maka/discussions/4268) 曾提议区分模型写的 commentary 与运行时推导的 activity，指出工具事件只能证明执行事实，不能生成「我发现根因」一类模型判断。但这是一份**讨论及早期方案**，其中提到的统一 `phase`、`ProgressUpdate` 工具、折叠工作日志均不能据此认定为已上线。
- [已合并 PR #4270](https://github.com/apache/maka/pull/4270)（2026-09-03 合并）给出最终较窄的实现：在主会话提示中要求模型于有意义的工具工作前和长任务中写简短进展；进展沿**现有普通 assistant text 流**进入扁平时间线，工具/推理活动仍按各自机制展示。PR 明确排除统一 commentary 字段、合成进度工具、额外模型请求与完成后工作日志折叠。其正文和 [改动文件](https://github.com/apache/maka/pull/4270/files) 是已合并实现的依据，优先于讨论里的提案。普通 assistant text 能否稳定产生高质量进展仍取决于模型遵循提示；PR 仅保证展示和保存现有文本的路径，并提供等待模型输出的真实状态。

#### 进展文本是否进入下一次模型调用

**Maka 当前主线（核对提交 `ae71ab3`）默认会纳入已结算的模型进展文本。** [进展提示](https://github.com/apache/maka/blob/ae71ab319c920b856c2f18ee6c8d022e38376f71/packages/runtime/src/system-prompt/main-session-prompt.ts#L58-L70)要求模型在工具调用前及有实质变化时写普通 assistant text。它没有引入专门的 `commentary` 事件或设置“仅 UI 可见”语义。[模型历史投影](https://github.com/apache/maka/blob/ae71ab319c920b856c2f18ee6c8d022e38376f71/packages/runtime/src/model-history.ts#L877-L1025)排除 `partial` 事件、`modelVisibility: hidden` 事件等，然后把符合条件的 `role: model` 文本转为 assistant replay item；[同文件末尾](https://github.com/apache/maka/blob/ae71ab319c920b856c2f18ee6c8d022e38376f71/packages/runtime/src/model-history.ts#L1230-L1263)也把这些文本列入 `textMessages`。当前 Turn 的后续模型步骤会调用此投影来构造请求（[ai-sdk-turn.ts](https://github.com/apache/maka/blob/ae71ab319c920b856c2f18ee6c8d022e38376f71/packages/runtime/src/ai-sdk-turn.ts#L1354-L1407)）。因此“进展只进 UI，绝不进后续模型上下文”**不是 Maka 当前实现**。

边界是：流式临时 chunk 不回放，显式隐藏的文本不回放；中断文本的历史回填会标为 `modelVisibility: hidden`（[runtime-event-backfill.ts](https://github.com/apache/maka/blob/ae71ab319c920b856c2f18ee6c8d022e38376f71/packages/runtime/src/runtime-event-backfill.ts#L157-L173)）。更长历史还可能经过上下文预算、裁剪或压缩，以摘要代替原文；[文章的 Compaction 段落](https://github.com/apache/maka/blob/ae71ab319c920b856c2f18ee6c8d022e38376f71/docs/blogs/log-is-the-runtime.md#compaction-projections-as-materialized-views)明确区分完整日志和有界模型上下文。这里说“默认纳入”指原始事件满足可见与回放条件时会成为投影输入，不保证每一条旧进展永远原样出现在每次模型请求中。

### Codex 公开协议

- [Codex app-server 文档](https://developers.openai.com/codex/app-server) 公开了 `Thread → Turn → Item`，以及 `item/started`、`item/completed`、`item/agentMessage/delta` 等通知。`agentMessage` 包含文本及可选的 `phase`；出现时使用 `commentary` 或 `final_answer`。`reasoning`、`commandExecution`、`mcpToolCall`、`plan` 是不同 item 类型，`turn/plan/updated` 另传计划状态。因而在公开协议中，面向人的进展文本有独立于工具执行细节的表达渠道。
- [Codex 非交互模式文档](https://developers.openai.com/codex/non-interactive-mode) 同样列出 JSONL 事件中的 agent messages、reasoning、command executions、file changes、MCP calls、plan updates。它说明客户端可消费结构化流，但没有规定 Telegram 这类外部客户端应如何分页、编辑或折叠。
- 截图可以观察到 Codex 客户端呈现有内容的中途说明与工具活动；**不能仅凭截图断言桌面客户端内部持久化、折叠或重连算法**。公开 app-server 协议能证实事件类别和流式边界，不能证明所有桌面 UI 内部实现。
- [Codex app-server 官方文档](https://developers.openai.com/codex/app-server)说明 `agentMessage` 可带 `commentary` / `final_answer` 阶段，并提供消息流通知；它没有规定下一次模型调用如何选取这两类消息。因此仅凭这个协议，不能断言 Codex 的 commentary 必然进入或必然排除模型上下文。

### Telegram API 与本仓库

- Telegram [Bot API 的 `sendMessage`](https://core.telegram.org/bots/api#sendmessage) 发送新文本消息并返回 `Message`；[`editMessageText`](https://core.telegram.org/bots/api#editmessagetext) 需要 `chat_id` 与 `message_id`（或 inline ID）来编辑已有消息。这使「逐条发进展」和「编辑一条进展消息」成为两种不同的 UI 投影策略；后者若需重启恢复，应可靠保存 Telegram 返回的消息 ID。
- 本仓库 [`src/pi-agent.ts`](../../src/pi-agent.ts) 第 85–110 行排空 `text_delta`、`thinking_delta`、`toolcall_delta` 后只返回最终 settled message；第 171–190 行记录模型步骤、工具调用及 `message_end` 的 `model_message`，尚未把用户可见的中途文本交给 Telegram。第 66 行设置 `thinkingLevel: "off"`。
- [`src/app.ts`](../../src/app.ts) 第 67–82 行只在 `answer()` 返回后发送答案；[`src/main.ts`](../../src/main.ts) 第 32–40 行调用 `sendMessage`，但没有保留其返回的 `message_id`。因此目前既没有实时进展呈现路径，也没有重启后编辑进度消息的投递事实。
- [`src/runtime-log.ts`](../../src/runtime-log.ts) 第 6–11 行的 `StoredEvent` 只有宽松的 `type`、`at`、`requestId` 等字段；第 50–65 行按 JSONL 读全量并追加。文件位置提供当前重放顺序；尚无显式持久 `event_seq`、事件/消息 ID 和 schema 版本。项目**已经**在 [`src/projection.ts`](../../src/projection.ts) 与 [`src/checkpoint.ts`](../../src/checkpoint.ts) 中使用事件数量、前缀摘要和最后事件摘要校验 checkpoint，因此差距不是完全缺少前缀校验，而是缺少所有消费者可共用的稳定事件身份和提交游标。
- [`src/pi-agent.ts`](../../src/pi-agent.ts) 第 171 行传给 `session.subscribe()` 的回调是 async，但已安装 Pi 的 `agent-session.js` 中 `_emit()` 直接调用监听器，不等待其 Promise（`node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js` 第 219–223 行；其 `.d.ts` 将监听器返回值定义为 void）。因此不能仅凭这个订阅接口假定模型步骤/消息事件已在下一步前持久化，或所有订阅写入在 `session.prompt()` 返回前都已完成。当前 `beforeToolCall` 与 `afterToolCall` 仍显式等待工具派发/结果写入，这是已有保护；未来公共日志提交边界应另外明确。这里是代码确认的接口风险，未通过故障注入证明每一种事件重排。

## 对设计的直接含义（推论）

1. 实质进展应由正在工作的模型/Agent 产生并作为用户可见文本保存；工具事件投影适合提供确定性的活动事实，无法可靠创造模型的判断、发现或下一步意图。Maka 最终实现也选择了模型写普通 assistant 文本，而非从工具日志反推叙事。
2. Runtime event log 可成为进展投影的持久来源，但先要确保**内容真的进入日志**，再决定 Telegram 是否显示。单纯增加工具事件种类、固定阶段名或渲染规则，不能补出缺失的进展说明。
3. Telegram 的呈现选择可在内容语义明确后独立决定。逐条消息保留时间顺序，编辑一条消息减少刷屏；两者都需要处理发送成功与日志持久化之间的边界。当前代码尚不足以支持可靠编辑恢复。
4. 若借鉴 Codex 的 `commentary`/`final_answer` 分类，要先决定本 bot 是否真的需要语义区分；Maka 的合并方案证明可以先复用普通 assistant text 时间线。不能把 Codex 的可选 `phase` 直接等同于 Maka 的最终数据模型。

## 待验证的问题

- 现有 provider 在本 bot 的提示与 streaming 接口下，能否稳定产出工具前/工具间的用户可读文本？需要用实际请求轨迹判断，而非凭工具事件推断。
- 本 bot 的进展文本是否纳入下一轮模型上下文，以及失败/中断时如何与最终答案区分。Maka 当前默认回放可见的已结算进展文本，但本 bot 可以单独选择自己的投影策略。
- Telegram 每条进展独立发送还是编辑单条消息：取决于期望的对话密度、历史保留、投递失败/重试与重启恢复要求。
