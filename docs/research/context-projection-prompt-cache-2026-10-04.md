# Context Projection、Prompt Cache 与 Reasoning：Codex、Pi、Maka

调研日期：2026-10-04（Asia/Shanghai）

目标是核对“持久历史、模型上下文、实时 UI、prompt cache 和 COT/reasoning”是否应使用同一套消息投影。结论来自 Codex 与 Pi 的一手源码/文档，以及本仓库此前对 Maka 固定提交的源码核对。

## 结论

**不能把模型上下文简化成 user/tool/assistant 三种角色的线性列表。** 至少需要区分：

1. 持久 transcript/runtime log：用于审计、恢复、UI 历史和重新投影；
2. Model Context Projection：针对某个 Provider 生成合法、紧凑、可续接的模型输入；
3. Live UI Projection：展示 reasoning summary、工具开始/完成、进度草稿和最终正文；
4. Provider/transport continuation：保存 reasoning signature、encrypted reasoning、response/continuation id、cache key 等不能被普通文本替代的元数据。

UI 可见不等于模型可见，模型可见也不等于普通文本可回放。是否送入下一次请求必须由 Provider-aware projection 决定。

## Codex

- Codex 为 Responses 请求维护会话级 `prompt_cache_key`。`codex-rs/core/src/client.rs` 的实现默认以 session id（内部子 agent 则以 parent thread 关联）生成 key，并允许显式 override。请求复用判断把 `input` 排除在“请求属性相等”之外，但要求 model、instructions、tools、reasoning、prompt cache key 等保持一致，才能复用 websocket/continuation。
- `codex-rs/core/tests/suite/prompt_caching.rs` 验证：每轮改变 reasoning/settings 后，`prompt_cache_key` 保持不变；旧请求的整个 prefix 保持为新请求的 prefix，只在后面追加/替换必要的配置消息。测试明确把这一点作为 cache hit potential 的条件。
- `codex-rs/core/src/context_manager/normalize.rs` 把合成输出 ID 的 namespace 视为模型可见协议的一部分，并注明改变会使 model-visible IDs 改变、从而使 prompt cache 失效。也就是说，稳定的序列化、ID 和消息顺序本身是缓存设计的一部分。
- Codex 的上下文管理保留不同的 `ResponseItem`：message、function call/output、reasoning、compaction、configuration update 等。`history.rs` 对 reasoning 的处理依赖 Provider 形态；带 encrypted content 的 reasoning 可参与模型可见 token 估算，而没有可回放内容的 plaintext reasoning 不计入 replay accounting。不能把它们粗暴降级成 assistant 文本。
- 上下文过长时 Codex 以 compaction item/summary 替换旧前缀，并保留 compaction provenance，而不是重写整个历史。配置变化使用 configuration update 等追加式输入，减少稳定前缀的破坏。

来源：

- <https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/core/src/context_manager/history.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/core/src/context_manager/normalize.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/prompt_caching.rs>

## Pi

- Pi 的 agent loop 把 `AgentMessage[]` 转换为 Provider 可接受的 `Message[]`。`packages/agent/src/types.ts` 明确写出：无法转换的消息，例如 UI-only notification/status，应在 `convertToLlm` 中过滤；`transformContext` 专门用于裁剪旧消息和注入外部上下文。这是 transcript 与 model context 的显式边界。
- Pi durable 文档把系统 prompt、工具声明和会话 instructions 当作有位置的 system entries；只有发生变化的 section 才重新发送，从而保持 provider prompt cache 的稳定前缀。文档特别警告：每次变化的 section（例如每次都带当前时间）会破坏缓存。
- Pi durable 的 compaction 追加一个 `pi.compaction` entry，保存摘要并指向保留的第一条历史；旧记录仍在存储中。模型上下文由 compaction projection 决定，原始 transcript 仍可查询。`viewState`/watch 是 UI 使用的 committed state，并不等于 model context。
- Pi 的 reasoning 不是普通 assistant 文本：Pi AI 以 thinking content block 流式传递，并在支持的 Provider 中保留 `thinkingSignature`。签名/Provider 兼容规则决定该 block 是否能安全回放；不能只看“用户是否能展开它”。

来源：

- <https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/types.ts>
- <https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent-loop.ts>
- <https://github.com/badlogic/pi-mono/blob/main/packages/durable/README.md>
- <https://github.com/badlogic/pi-mono/tree/main/packages/ai>

## Maka

本仓库此前对 Apache Maka 固定提交 `ec324da4f578cc111de2a1d2a20444c63432a365` 的核对显示：Maka 从 Runtime events 选择已提交、模型可见的项目构造 provider messages；Bot 的发送成功/失败没有回写为模型历史的门槛。它支持模型生成文本继续留在历史中，但现有 Bot 路径没有独立的 delivery fact → model context 投影。

Maka 的证据链和限制已记录在 [`maka-delivery-model-projection-2026-09-29.md`](./maka-delivery-model-projection-2026-09-29.md)。这项调研不能证明 Maka 对 prompt cache 或所有 Provider reasoning continuation 都有统一策略。

## 对 nailong bot 的修订

`Context Inclusion` 不应是给每个事件一个简单的 `includeInContext: boolean`。建议改成两层：

1. **语义记录层**：事件保存 `kind`、`source`、Provider continuation metadata、`uiVisibility`、`modelReplayPolicy` 和 `durability`；
2. **Provider-aware projection 层**：根据 Provider 能力生成输入。普通 tool call/result、user input、最终 assistant text 是常见的基础项，但 reasoning 只有在 Provider 要求且拥有可回放的签名/加密内容/continuation id 时才回放；UI-only commentary、draft、delivery fact 和逐 token delta 默认过滤。

上下文投影还要维护以下不变量：

- 稳定 system/instructions/tool 前缀和会话级 cache key；动态时间、UI 进度、投递状态不能插入稳定前缀；
- 配置变化使用 append-only configuration/update item，避免重写历史前缀；
- 事件序列、模型可见 ID、tool call/result 关联和 reasoning continuation metadata 保持稳定；
- 历史压缩生成显式 compaction summary，并保留原始 transcript；
- UI timeline 可以显示 reasoning summary 和工具事实，但不因此改变下一轮模型输入；
- 如果 Provider 不支持 reasoning replay，只保留用户可见 summary 或 UI 记录，不把原始 COT 伪装成 assistant 历史。

因此，Q21 应修订为：**默认投影不是 user/tool/assistant 三类，而是 Provider-aware 的 context item union；“进入模型上下文”由可续接性、缓存前缀稳定性和 Provider 协议共同决定。**
