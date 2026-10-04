# Akashic Agent 的模型进展与 UI 投影调研

调研日期：2026-10-04。目标仓库：[`kachofugetsu09/akashic-agent`](https://github.com/kachofugetsu09/akashic-agent)，固定到提交 [`983a077`](https://github.com/kachofugetsu09/akashic-agent/tree/983a077)。只检查该仓库的 README、源码、测试和设计文档。

## 先给结论

这个项目没有把 `read file`、`call tool` 之类的硬编码词汇拼成“进展”。它把实时展示拆成三层：

1. **模型产生的 thinking/reasoning**：Provider 如果返回原生推理或推理摘要，就通过 `thinking_delta` 流到客户端；Codex Provider 还可以请求 `reasoning.summary`（`none`、`auto`、`concise`、`detailed`）。这部分是模型内容，不是 UI 根据工具名推导的描述。
2. **确定性的工具时间线**：工具开始/结束和文本/思考 delta 通过严格类型的 `TurnStreamEvent` 发布。它能证明“哪个工具正在运行”，但不会凭工具事件创造“我发现了根因”这样的模型判断。
3. **持久消息与短命草稿**：正式 `Message`（Input/Output/ToolResult）按 `seq` 进入消息日志；流式文本和 thinking 在模型调用完成前放入 `reply.status` 的内存快照。客户端收到同一 `message_id` 的正式消息后，用它替换草稿。

所以，Akashic 最接近用户所说的 Codex 体验的部分是“**模型原生 reasoning summary + 可折叠的 thinking 行 + 工具时间线**”，而不是一个独立的、由运行时自动生成“必要性说明”的 `ProgressEvent` 协议。若模型或 Provider 不提供有意义的 reasoning，Akashic 也不会从工具名反推高质量叙事。

## 实时事件协议

核心的展示事件定义在 [`agent/plugin_composition/channels.py`](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/agent/plugin_composition/channels.py#L572-L684)：

| 事件 | 内容 | 语义 |
| --- | --- | --- |
| `turn.started` | `turn_id`、客户端输入 ID | 建立本次实时展示关联 |
| `stream.delta` | `text_delta`、`reasoning_delta`、单调 `sequence` | 同时承载回答文本和模型 thinking 流 |
| `tool.started` / `tool.completed` | `tool_call_id`、`tool_name`、序号 | 工具活动事实；不包含模型判断 |
| `turn.output.completed` | 序号 | Provider 的可见输出结束信号，不等同于持久 turn 终态 |

`TurnStreamEvent` 在回调前冻结 `presentation_id`、事件类型和对应 payload；订阅者必须返回 `PresentationReceipt`（同文件约 [L637-L684](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/agent/plugin_composition/channels.py#L637-L684)）。这是渠道展示协议，不是 Message 日志。

Web 渠道在 [`plugins/akashic_clients/web_chat.py`](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/akashic_clients/web_chat.py#L318-L423) 把它投影成 WebSocket 帧：`react.thinking.delta`、`answer.delta`、`react.tool.started`、`react.tool.completed` 和 `turn.output.completed`。客户端协议在 [`frontend/chat/src/web-chat-transport.ts`](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/frontend/chat/src/web-chat-transport.ts#L7-L124) 校验这些帧，并在 [L238-L329](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/frontend/chat/src/web-chat-transport.ts#L238-L329) 分别累积 thinking、工具块和回答正文。

## “模型思考”从哪里来

### Codex Provider：可请求 reasoning summary

Codex 模型配置允许 `reasoning_summary` 为 `none`、`auto`、`concise` 或 `detailed`，见 [`plugins/codex/driver.py`](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/codex/driver.py#L147-L161)。请求构造器在 summary 非 `none` 时发送 `reasoning: { summary: ... }`，同时保持 `stream: true`，见 [`plugins/codex/responses.py`](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/codex/responses.py#L176-L204)。

流解析器接收 `response.reasoning_summary_text.delta` 和 `response.reasoning_text.delta`，统一追加到 `thinking` 并通过 `on_delta({"thinking_delta": ...})` 推送，见 [responses.py L221-L281](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/codex/responses.py#L221-L281)。这说明它优先使用 Provider 返回的模型推理/摘要，而不是运行时用固定模板模拟进度。完成时 `LLMResponse.thinking` 保存该文本；reasoning output item 也被筛选成可续接的 continuation（[L294-L315](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/codex/responses.py#L294-L315)、[L554-L563](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/codex/responses.py#L554-L563)）。

### OpenAI-compatible Provider：原生字段优先，旧协议再解析 `<think>`

兼容 Provider 的流解析先读取 `delta.reasoning_content`，其次读取 `delta.reasoning`；收到后产生 `thinking_delta`。只有 Provider 没有原生 reasoning 字段时，才保留并解析 `<think>...</think>` 标记，见 [`plugins/openai_compatible/driver.py`](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/openai_compatible/driver.py#L678-L810) 以及 [L856-L915](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/openai_compatible/driver.py#L856-L915)。该驱动明确拒绝 `reasoning_summary` 配置（它属于 Codex 驱动的协议能力），见 [L422-L440](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/openai_compatible/driver.py#L422-L440)。

因此跨 Provider 的公共层只接收 `content_delta` 和 `thinking_delta`；“是否是摘要、是否是完整 reasoning、如何产生”由模型适配器决定。

## 持久化与上下文边界

模型响应通过 [`plugins/models/projection.py`](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/models/projection.py#L48-L76) 写入普通 `ContentPart("model.facts", ...)`，其中保存调用记录 ID、工具调用映射、`thinking` 和 provider continuation。`check_facts` 验证 thinking 必须是字符串或 `None`（[L113-L178](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/models/projection.py#L113-L178)）；页面展示只读取调用 ID 与 thinking，`display_facts` 不暴露 continuation（[L191-L195](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/models/projection.py#L191-L195)）。

在模型历史投影中，thinking 会被送回 provider 的 `reasoning_content`，见 [projection.py L599-L600](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/models/projection.py#L599-L600)。这意味着 **Akashic 的 thinking 默认既是 UI 可见过程，也是模型重放所需的事实**；它没有把“仅 UI 可见的 commentary”作为公共字段单独隔离出来。若 nailong bot 不希望把进展污染下一轮上下文，需要自行增加可见性/上下文投影边界，而不能直接照搬 `model.facts.thinking`。

## 短命预览 vs. 持久时间线

### `reply.status`：流式草稿

[`plugins/reply/status.py`](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/reply/status.py#L19-L119) 的 `ReplyState` 只保存当前进程活动 scope 的 `handle`、来源、`active` 和 `ReplyPreview`。每次真实模型调用前预分配 `message_id`，delta 回调累积 `text` 与 `thinking`；调用 scope 结束就清理预览。`ReplyRead.follow` 只重复当前快照，不重放旧 token（[L19-L36](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/plugins/reply/status.py#L19-L36)）。

前端协议把它定义成 `reply.status`，并严格区分 `messages.appended`（持久事实）和 `reply.status`（当前活动/草稿），见 [`frontend/chat/src/message-timeline.ts`](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/frontend/chat/src/message-timeline.ts#L42-L100)。设计文档明确说明：预览只存在内存，重连只重新读取 durable seq 和当前活动快照，不恢复旧 token；同 ID 的正式 Message 到达后接替草稿，见 [`docs/design/0902-reviewed-v4.md`](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/docs/design/0902-reviewed-v4.md#L1382-L1427)。

### 持久 Message：按 seq 重放

`TimelineMessage` 的正文类型包括 `input`、`output`、`tool_result`；`model.facts` 是 output 内部的普通 content part，ToolCall 与 ToolResult 通过 `call_ref` 关联。前端先验证消息身份、seq、part 和附件，再根据可见性投影；`isTimelinePartVisible` 只让有 thinking 的 `model.facts` 进入可见过程，见 [message-timeline.ts L177-L258](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/frontend/chat/src/message-timeline.ts#L177-L258)。

## UI 如何表达“思考”和工具活动

WebSocket 帧被转成 `AgentBlock`：thinking block、tool block、answer text 各自独立。[`frontend/chat/src/message-view.tsx`](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/frontend/chat/src/message-view.tsx#L90-L118) 的 `ReplyActivityView` 把实时草稿的 thinking 与已有时间线合并；[L276-L299](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/frontend/chat/src/message-view.tsx#L276-L299) 的 `TimelineProcess` 按顺序显示 thinking 和工具过程。

thinking 行由 [L557-L601](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/frontend/chat/src/message-view.tsx#L557-L601) 的 `ThinkingRow` 渲染：流式期间自动展开，结束后约 1 秒自动折叠；折叠标题使用 thinking 文本的最后一个非空行作为摘要，同时显示“正在思考 / 已思考 N 秒”。内容本身仍可展开查看。工具块由 `ToolStep` 独立渲染（同文件 [L605-L675](https://github.com/kachofugetsu09/akashic-agent/blob/983a077/frontend/chat/src/message-view.tsx#L605-L675)），因此工具事实和模型思考没有混成一条硬编码状态文本。

## 这对 nailong bot 的直接启发

1. 如果目标是“像 Codex 一样解释为什么需要下一步”，应让模型/provider 产生**短的 reasoning summary 或 commentary 文本**，再通过 `thinking_delta`/专用 commentary 流显示；不要从 `tool_name` 反推叙事。Akashic 的 Codex 路径是配置 `reasoning_summary` 并消费 `reasoning_summary_text.delta`。
2. 应把 **模型语义** 与 **运行事实** 分开：`thinking/commentary` 解释意图、发现和下一步；`tool.started/completed` 只陈述工具调用及结果；`answer.delta` 只承载最终回答。
3. 应保留两种恢复边界：持久日志（带稳定 `message_id`、`seq`、ToolResult 引用）用于重连和历史；短命预览（带预分配 ID、文本/thinking 草稿）用于低延迟 UI。预览不能当作“已完成”的送达事实。
4. Akashic 把 `model.facts.thinking` 回放到模型上下文；如果本项目决定“用户看到的进展不进入上下文”，需要单独的 `visibility`/`context inclusion` 策略，不能直接复用这一字段。
5. Akashic 的标题摘要只是 thinking 的最后一行，并不负责生成阶段总结。要得到“我正在检索记忆，因为它能避免重复询问”这种产品级文案，需要在模型提示/Provider summary 或独立 commentary 协议中明确要求模型提供理由和下一步，并由 UI 折叠展示。

## 研究范围限制

本调研没有运行真实模型请求，也没有把 UI bundle 在浏览器中执行；结论来自固定提交的源代码、测试接口和设计文档。仓库中存在旧版生命周期事件（例如 `bus/events_lifecycle.py`），但当前 Web 活动路径使用 typed `TurnStreamEvent`、`reply.status` 与 Message v2；不能把旧事件类当成当前产品协议。
