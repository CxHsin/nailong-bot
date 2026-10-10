# Provider 公开进展与最终答复的统一协议研究

调研日期：2026-10-10（Asia/Shanghai）。本笔记直接检查两项目的当前默认分支源码，未执行第三方程序。

固定源码版本：

- DeepSeek Harness：[`d743267388641bc76f17c45ce8b4c231aed1d32c`](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)。
- Akashic Agent：[`88a54e613bc0d8d7a76dce9042156ad0b6f911c2`](https://github.com/kachofugetsu09/akashic-agent/tree/88a54e613bc0d8d7a76dce9042156ad0b6f911c2)。

## 结论

**可以统一 Host 和 Channel 的公开输出语义；不能只靠通用 Chat Completions 的 `content` 流，可靠恢复原生 `commentary / final_answer` 的所有能力。** 没有阶段字段、没有工具调用、没有额外控制信号时，“我发现了 X，接下来做 Y”究竟是继续执行的公开进展还是用户要求的最终答复，协议并未说明；仅凭文本语气判断会误判。

用户提供的两项目都值得借鉴，但它们当前核心循环采用的是“有工具继续、无工具完成”。两者的公开正文和 reasoning 分开，均未在所检查的核心路径中实现通用的公开 `commentary / final_answer` 阶段协议。因此，不能声称这两个项目已经解决“无工具 commentary 之后继续生成”的问题。

推荐将 **公开文字、执行控制、Provider 原始回放信息** 分开：Host 消费统一的有序文字段与继续/完成结果；适配层负责原生 phase 或工具边界的归一化。普通 Provider 的工具步骤正文已经是同一执行模型产生的可公开进展，不需要独立摘要模型。若要求它也支持纯文字进展后继续，则必须增加明确的继续协议，例如受校验的控制工具；这属于额外设计选择，不应暗藏在正文猜测中。

## DeepSeek Harness 源码证据

### 1. 通用内容类型区分公开文字、reasoning 和工具调用

`TextBlock` 注释为“Plain text visible to the end user”；`ReasoningBlock` 明确是“distinct from visible text”。`ContentBlockMap` 同时包括 `text`、`reasoning`、`tool-call`；结束原因独立表示 `stop / tool-calls / max-tokens / aborted / error`。这一层没有 commentary/final 阶段字段。见 [`types.ts:61–71`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm/src/types.ts#L61-L71) 与 [`types.ts:137–165`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm/src/types.ts#L137-L165)。

Pi 适配器把 `text_start / text_delta / text_end` 映射成通用文字块；`thinking_*` 映射到独立 reasoning 块，工具参数是另一条流。它不会把 thinking 自动作为公开进展总结。见 [`stream.ts:152–207`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm-pi-ai/src/stream.ts#L152-L207)。

某个界面可以选择展示 reasoning 块，但这仍不同于执行模型主动向用户报告“有证据的阶段结论和下一步”。不能把 reasoning delta 改名为 commentary 来满足此需求。

### 2. 无工具结束，有工具执行后继续

核心循环消费同一次模型流，提交该步骤 assistant message 后，从内容中提取工具调用。没有工具就返回 `completed`；有工具就执行，工具未主动结束本轮时进入下一步。`max-tokens` 是单独的异常结束结果，不会当作完整答复。见 [`agent.ts:443–460`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts#L443-L460) 与 [`agent.ts:529–555`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts#L529-L555)。

工具结果可带 `concludesTurn`，即执行控制属于工具/循环协议，而非通过 prose 关键词猜测。该标记只存在于成功工具结果上。见 [`tools/index.ts:425–435`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/tools/src/index.ts#L425-L435) 与 [`tool-calls.ts:140–158`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/tool-calls.ts#L140-L158)。这不是一个内置的“report_progress”工具。

### 3. 预览与耐久提交共享同一块序列

`AssistantStreamAttempt.push` 将同一 chunk 同时送入 accumulator、assembler 和 live frame；live frame 有 attempt identity、revision、index。`settle` 先提交耐久事件，再发送带 committed sequence 的 end frame；提交失败走 abandonment。见 [`assistant-stream.ts:59–108`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/assistant-stream.ts#L59-L108)。这是可借鉴的预览与结算协议，避免把失败请求的临时文字当作完成事实。

不同 channel 不一定都逐 token 显示。Headless JSON 的注释明确声明它在 `assistant/message` 提交时才输出 text/reasoning，并在 final 事件输出最终答案。见 [`json-stream.ts:229–236`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/bundle/headless/src/json-stream.ts#L229-L236)。不能从核心支持流式推导所有出口都流式。

### 4. 原生回放保真与通用内容分开

回放 envelope 保存 API、Provider、请求模型、stopReason、各块的 textSignature/thinkingSignature/tool thoughtSignature；正文和工具调用仍以 Harness 的耐久内容为准。重放时校验块数、顺序、类型及 Provider/模型身份；不适用或损坏的 envelope 降级为通用历史，保留诊断。见 [`replay.ts:15–35`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm-pi-ai/src/replay.ts#L15-L35)、[`replay.ts:77–109`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm-pi-ai/src/replay.ts#L77-L109) 和 [`replay.ts:186–258`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm-pi-ai/src/replay.ts#L186-L258)。

在所检查的主循环中，公开文字直接来自执行请求，没有针对这些文字再发一个 progress 摘要请求。不能据此断言整个项目没有其他模型调用；标题、压缩等功能有各自模块。

## Akashic Agent 源码证据

### 1. 同一 agent 请求的正文和 thinking 分别流出

Reply 选择模型后通过 `execution.chat("agent")` 绑定执行模型，ReAct 的 `_complete` 直接调用该模型，并把当前 preview callback 作为 `on_delta` 传入。见 [`reply_program/program.py:115–124`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/reply_program/program.py#L115-L124) 与 [`react/plugin.py:416–433`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/react/plugin.py#L416-L433)。

OpenAI compatible SSE 解码器分别读 `content` 和 `reasoning_content / reasoning`，发送 `content_delta` 与 `thinking_delta`。它还兼容 legacy tagged thinking，但这是 reasoning 拆分，不能作为公开阶段标记的先例。见 [`openai_compatible/driver.py:864–898`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/openai_compatible/driver.py#L864-L898) 与 [`driver.py:915–930`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/openai_compatible/driver.py#L915-L930)。

### 2. 工具出现之后，该兼容解码器压制后续正文预览

`tool_seen` 在 tool_calls delta 出现后置为 true；后续 text/thinking preview 都受 `not tool_seen` 条件限制。响应中正文仍被收集并结算，但“它已经全程流式输出工具步骤结论”不是当前源码支持的结论。见 [`driver.py:858–898`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/openai_compatible/driver.py#L858-L898)。

### 3. Output 明确有 continue/complete，但仍由工具存在性决定

ReAct 将 decoded 正文与工具调用写入同一个 Output；有工具调用位置 `indices` 时 mode 为 `continue`，没有则为 `complete` 并返回。生成触达 `finish_reason == "length"` 会先报错，不执行截断参数中的工具。见 [`react/plugin.py:577–636`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/react/plugin.py#L577-L636)。

另有调用方可配置的 `terminal_tools`：其成功结算后可写 quiet Output 并停止，但并非普通文本自行决定继续。见 [`react/plugin.py:559–565`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/react/plugin.py#L559-L565)。

Akashic 的 Codex Responses 解码器也把 output_text.delta 合并进一个 content list；reasoning 独立，不读取消息项的 phase。见 [`codex/responses.py:251–312`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/codex/responses.py#L251-L312)。不能把“有 Codex adapter”当作实现 Codex commentary 语义的证据。

### 4. 临时预览按物理尝试重置，耐久历史恢复包含协议事实

Reply preview 将 text 与 thinking 分字段追加；物理调用 identity 改变或 retry_status 出现时清空旧预览，离开 scope 后撤除预览，取消之后不允许迟到 callback 重新发布。见 [`reply/status.py:84–119`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/reply/status.py#L84-L119)。

`model.facts` 保存调用账指针、原始工具 ID、thinking 和 binding 限定的 continuation；Context Projection 从耐久日志重建工具协议与内容，不把临时草稿作为历史。见 [`models/projection.py:52–102`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/models/projection.py#L52-L102) 与 [`models/projection.py:300–382`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/models/projection.py#L300-L382)。

执行预览没有辅助 progress 摘要请求；`_complete` 中的可选 reduce 属于上下文压缩，并且只以 retry_status 反馈压缩状态。不能把这些状态当作模型对任务证据的新结论。见 [`react/plugin.py:364–433`](https://github.com/kachofugetsu09/akashic-agent/blob/88a54e613bc0d8d7a76dce9042156ad0b6f911c2/plugins/react/plugin.py#L364-L433)。

## 统一设计及本轮采纳范围

用户确认选择“先统一事件层，普通 Provider 按工具调用与正常结束判断阶段”。本轮已实现共用 `publicTextPhase` 适配：`RunProgress` 的公开文字事件和 `text_finalized` 结算事实共同携带 `phase / phaseSource`，来源区分原生字段、工具边界、正常终止；未定增量为 `unresolved / pending`，可以立即流式显示。没有新增公开进展工具或正文 framing。以下纯文字继续方案保留为未采纳的候选，而非本轮实现承诺。

### 共用语义，保留来源差异

| 概念 | 统一记录 | Provider 适配职责 |
| --- | --- | --- |
| 公开文字段 | 稳定 segmentId、顺序、delta、settled text、公开 phase | 原生 item 或通用文本块映射 |
| 阶段依据 | `native / tool-boundary / explicit-control / terminal-boundary` | 保存推断依据，不伪造原生字段 |
| 执行控制 | `continue / final / incomplete / failed / cancelled` | phase、工具调用与 finish reason 联合决定 |
| 非公开推理 | 单独的 reasoning 内容/原生元数据 | 不进入用户公开进展通道 |
| 耐久回放 | 每块内容、顺序、工具配对、原生 replay envelope | 同路线保真；跨路线安全降级 |

原生 Provider 的 `commentary` 可以在没有工具时继续，`final_answer` 可以明确终结。普通 Provider 先按工具边界建立最小适配：同一步中 accompanying text 是 progress，无工具且正常停止才是 final。接收中的文字先作为未定阶段的公开 draft；不能等到最终结果才显示，也不能为了早标成 final 而丢弃后续工具步骤结论。结算时确认阶段，Channel 无需重发正文或切换卡片。

执行控制与文字展示不能完全合并。例如含工具的一步即使输出了貌似 final 的 prose，仍需明确处理工具调用；`length / timeout / abort` 从来不代表完整 final。事件应保留 conflict/unknown 状态，必要时明确失败，避免无限继续。

### 纯文字继续的三种选择

| 方案 | 同一模型 | 逐 token 公开文字 | 没有真实工具仍能继续 | 代价与边界 |
| --- | --- | --- | --- | --- |
| 原生 phase + 工具/终止 fallback | 是 | 支持 | 原生模型支持；普通模型不支持 | 改动小，保留普通 Provider 的自然 completion 行为 |
| 非原生路线增加明确控制工具 | 是 | 可流式解析指定公开字符串参数，或流出工具前正文 | 支持 | 一次 progress 工具调用结束当前执行步骤，下一步仍是该模型；增加 continuation 请求与工具 schema，需防重复/并行语义 |
| 正文中的严格阶段 framing | 是 | 解析阶段头后立即流出正文 | 可在一个响应中支持多个公开段；跨响应继续还需结束控制 | 避免新增工具，但协议遵循依赖模型；chunk 拆分、代码示例、截断标签、错误标签、历史编码都需完整解析 |

第二、三种都不是从两参考项目中发现的现成实现，而是用于补齐协议缺口的候选。建议首先统一语义事件和正常工具路径，再在确实需要普通 Provider 无工具 commentary 的路线采用明确控制工具。不要依赖一个额外总结模型，也不要默认强制所有支持原生 phase 的模型改用工具协议。

若采用控制工具，工具职责仅是“发布已证实的简短结论并继续”，不得取得普通业务工具之外的执行能力。部分 JSON 参数只是草稿；只有完整参数及正常模型结束经校验后才结算进展、执行 continuation。工具确认消息与公开正文都必须耐久保存，以便下一模型请求和进程重启正确恢复。可以为纯进展工具设每轮预算，失败、取消或达到上限时不能伪装完成。

若希望两个分支外部行为完全一致，应按能力配置选择协议，而不是根据 Provider 名称硬编码。`phase` 能力属于实际 API / endpoint / model 路线；仅使用 Responses 格式不足以保证端点真的提供阶段。

### 验收标准

1. 支持 phase 的路线，同一个请求出现 commentary、工具调用、final_answer 或多个文字项时，顺序与段边界全部保留，commentary 不错误结束 Run。
2. 普通 Provider 正文伴随工具调用时，正文从真实 delta 持续追加，正常结算后成为 progress；无工具正常停止的正文成为 final。全程使用同一执行模型，无额外 progress 摘要请求。
3. 若选用明确控制工具，无业务工具的“结论→继续→最终答复”仍可完成；必须记录真实请求数量，区分正常 continuation 与额外摘要调用。
4. reasoning_content、thinking delta 和 encrypted reasoning item 不出现在公开进展文字中。只转换用户可见 content 或明确声明的公开参数。
5. 随机切分 SSE/JSON/阶段头；正文含中文、emoji、围栏代码和协议标记示例；没有重复、丢字、控制字符泄漏或错误工具执行。
6. 截断、超时、取消和 retry 不结算成 final；新的物理尝试不拼接旧 draft；迟到 delta 不重新发布取消后的预览。
7. 多段进展与工具调用配对在重启后仍按原顺序回放；跨 API / Provider / 模型切换时不发送不兼容签名或伪造原生 phase。
8. Channel 使用同一 Markdown 来源进行 draft 与正式保存；阶段适配不要求 Channel 理解模型协议、工具参数或 thinking 字段。

## 研究限制

结论对应以上固定提交的核心执行路径；未进行真实 Provider 或 Telegram 调用，未评估模型遵循自定义控制协议的成功率。这里的“未实现原生公开 phase”是对已检查类型、适配器、循环与回放路径的判断；两个项目仍可能通过第三方插件扩展行为。模型在长时间 reasoning 中没有公开 text 时，没有任何客户端适配器能凭空得到它对新信息的公开结论。

## Telegram 格式接口核验及本轮实现

官方 Bot API 文档核验于 2026-10-10。普通 [`sendMessage`](https://core.telegram.org/bots/api#sendmessage) 的 `parse_mode` 是可选字段；未指定时不会自动把普通 Markdown 解析成格式。指定 `MarkdownV2` 可以开启普通消息格式，但该语法的转义规则和 GFM 不相同，不能直接把模型常见的 `**粗体**`、标题和表格正文当作 MarkdownV2。

当前官方 API 提供 [`sendRichMessageDraft`](https://core.telegram.org/bots/api#sendrichmessagedraft) 与 [`sendRichMessage`](https://core.telegram.org/bots/api#sendrichmessage)，共同接受 [`InputRichMessage.markdown`](https://core.telegram.org/bots/api#inputrichmessage)。[Rich Markdown](https://core.telegram.org/bots/api#rich-markdown-style) 尽可能兼容 GitHub Flavored Markdown，支持标题、表格、列表、围栏代码和公式；无需本地转换为 HTML，也无需 `parse_mode: MarkdownV2`。这对接口适合本项目的模型正文。

原生 draft 只面向私聊，30 秒后过期；同一非零 `draft_id` 的变化有动画。完成后仍必须正式发送完整内容才能保留。保证的是同一来源正文与格式，Telegram 并未提供把临时 draft 原地变成同一条耐久消息的承诺。[Rich limits](https://core.telegram.org/bots/api#rich-message-limits) 当前为 32768 UTF-8 字符、500 blocks、16 层嵌套、50 附件、20 表格列；本项目正式分页仍保守限制 3500 源码字符，并在长代码页重开/闭合围栏。

用户进一步要求“去除原来的 html 格式”，本轮生产 Channel 已移除 HTML 发送、编辑和草稿回退，以及折叠 journal 路径。进展、状态和最终答复共同使用 Rich Markdown API；未闭合 Markdown 的 400 拒绝不触发 HTML 草稿。上一份有效预览继续保留，后续 snapshot 经退避重试原生接口。Rich endpoint 不可用时保留交付失败事实，不发送另一种格式。历史兼容 application 的旧事件投影未在此次 Channel 修改中重写。

分页器直接处理 Markdown 块与行内结构，不依赖 HTML 排版结果；长列表和引用中的围栏在每页闭合，长加粗段落重新打开行内容器。超出 32768 字符的草稿展示最新有界页面，持续保留同一 draft ID；正式分页交付仍保留全文。

本轮没有调用真实 Telegram Bot，也没有评估客户端动画的视觉质量；本地验证覆盖实际 grammY HTTP 取消、400/404/429 不切格式、长代码与 Unicode 分页、阶段及最终文字在结算前可见。已实现上文用户采纳的阶段事件归一化；公开控制工具未实现。
