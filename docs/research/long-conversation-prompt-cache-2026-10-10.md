# 长期连续对话：上下文压缩、投影稳定性与 Prompt Cache

调研日期：2026-10-10（Asia/Shanghai）。使用官方文档与固定提交的官方 GitHub 仓库；下文区分一手事实、对 nailong bot 的建议和尚未验证的能力。研究用于讨论，不改变当前 ADR 或实现。

## 结论

产品所说的持续对话，通常是**持久保存历史、维护有界的活动上下文、必要时压缩或检索**，不表示全部历史永远驻留在服务端 KV Cache。Prompt Cache 复用的是仍有效且匹配的输入前缀；保存历史或 response ID 不能替代缓存 TTL。[OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state#previous_response_id-in-websocket-mode)、[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[Pi compaction](https://github.com/earendil-works/pi/blob/42a3497d03ad17e308a2299fa824727894f2c0ec/packages/coding-agent/docs/compaction.md#L29-L49)

一手材料支持的共同方向是：正常交互期间稳定追加；需要释放容量时批量改写；改写后固定新投影并继续追加。**压缩会损失被改写部分之后的前缀缓存，但不必损失其前面独立缓存的固定提示词。** 应比较总成本、响应延迟和任务延续质量，而不是为了百分比保留无用内容。[Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing#context-editing-and-prompt-caching)、[Anthropic compaction caching](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold#maximizing-cache-hits-with-system-prompts)、[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

对本项目最直接的借鉴是 OpenClaw：**原始工具结果保留，发送给模型的裁剪投影保持稳定并持久化，下一轮不自动恢复成全文。** 它保护最近三轮免于工具裁剪，不能理解成“全部历史只保留三轮”。[OpenClaw session pruning](https://github.com/openclaw/openclaw/blob/4578c1dde1cb8b7217709845d091176e1d2cccc5/docs/concepts/session-pruning.md#L9-L15)、[保护范围](https://github.com/openclaw/openclaw/blob/4578c1dde1cb8b7217709845d091176e1d2cccc5/docs/concepts/session-pruning.md#L100-L102)

## 官方 API：缓存和压缩是两项能力

### OpenAI

- 当前官方 Prompt Caching 文档针对 GPT-5.6 及之后的模型提供 `prompt_cache_options.mode`（explicit/implicit）与 `input_text.prompt_cache_breakpoint`。隐式模式在适用的 user/tool/developer 结尾设置缓存点；查找范围包含最前两个、最近五十个显式点，以及最多二十个更早的适用结尾。默认 TTL 为 30 分钟，从最近一次写入或复用刷新。缓存键在这些模型上可用于独立统计，并非使用缓存的必要条件。[官方缓存文档](https://developers.openai.com/api/docs/guides/prompt-caching)
- `comparison_response_id` 可以请求 best-effort 缓存诊断，原因包括 `input_changed` 和 `context_compacted`；它用于比较，不能加载此前对话。[官方 diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)
- 服务端 `context_management.compact_threshold` 到阈值生成不透明、加密的 compaction item。stateless 请求可以移除最新 compaction item 前的项目；使用 `previous_response_id` 时不应手动裁剪。独立 `/responses/compact` 返回的窗口须原样使用。[官方 compaction](https://developers.openai.com/api/docs/guides/compaction)
- `previous_response_id` 提供连续状态；其链中的历史输入仍参与计费。它不意味着无限 KV 保存或免除历史输入成本。[官方 conversation state](https://developers.openai.com/api/docs/guides/conversation-state#previous_response_id-in-websocket-mode)

这些是 OpenAI 官方端点的当前能力。nailong 使用自定义兼容端点，不能仅因模型名相同就假设支持上述缓存点、TTL、诊断或 compaction。适配器与端点能力需要单独验证。

### Anthropic

- 缓存覆盖 `tools → system → messages` 的前缀。改变某个层级会影响该层及后续；不断增长的对话推荐移动末尾缓存点，旧内容保持不变。自动缓存也沿用同一机制，存在二十个 block 位置的回查限制；不能把“内容很稳定”理解成任意稳定子串都能命中。[官方 prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#how-automatic-prefix-checking-works)
- 默认缓存 5 分钟，可选择收费更高的 1 小时；命中刷新 TTL。TTL 从读取或写入请求开始计算，生成耗时也占用这段时间，所以个人聊天间隔长时即使输入完全稳定，也可能冷启动。[TTL](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#how-prompt-caching-works)、[1 小时缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration)
- Context editing 可按阈值从最旧工具结果开始替换成占位符；客户端仍保留完整历史。官方明确：清理使该点后的缓存失效，应使用 `clear_at_least` 一次释放足够 token，使重建缓存值得；后续请求可以复用新前缀。[context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing#tool-result-clearing)、[缓存交互](https://platform.claude.com/docs/en/build-with-claude/context-editing#context-editing-and-prompt-caching)
- Compaction 既有阈值方式，也有应用决定何时发起的 on-demand 方式。后者返回带签名的 summary block，后续按原样发送并替换其覆盖的旧消息。Keep-tail 由应用选择切点，旧部分摘要，近期部分原样保留；工具调用与结果须位于切点同一侧。[compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)、[on demand](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)、[keep recent turns](https://platform.claude.com/docs/en/build-with-claude/compaction-keep-recent-turns)
- 官方建议固定 system prompt 单独设置 cache breakpoint，让压缩后仍能命中该部分。替换摘要需要新的缓存写入，不能宣称压缩零代价。[compaction caching](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold#maximizing-cache-hits-with-system-prompts)

这些 API 功能不能直接当成 Claude Code 的实际内部参数；也不能当成其他兼容端点的协议。

## 产品与开源实现

| 案例 | 已公开的一手行为 | 对本项目的启发 |
| --- | --- | --- |
| Claude Code | 接近窗口限制先清旧工具输出，再摘要；可能丢失早期细节；巨型输入造成连续压缩后立即满时，数次后停止并报 thrashing 错误 | 工具结果先控制大小；给压缩失败和无进展设停止条件；长期约束不要只靠摘要 |
| Codex | 缓存测试要求旧 input 保持为新 input 的完整前缀；配置更新用追加消息。压缩维护替换后的 history 与窗口元数据 | 将前缀稳定性作为投影契约；压缩是明确的版本边界 |
| Pi | 达 `contextWindow - reserveTokens` 才压缩；保留近期 token tail；摘要加保留后缀；持久 entry 保存切点 | 用 token 预算取代固定轮数，保留尾部并记录压缩覆盖边界 |
| OpenClaw | 稳定工具投影持久化；适用客户端路径等 TTL 过期才开始新一轮裁剪；长期记忆与活动历史分开 | 同一工具结果跨轮使用相同投影；把 idle 视为可批量整理的时机，而不是恢复全文 |

上述表格的来源及限制如下。

### Claude Code：公开行为，不是公开源码策略

官方产品文档说明上下文包含历史、文件、命令输出、CLAUDE.md、auto memory 和系统指令。接近上限时先清旧工具输出，再摘要；请求和关键代码会保留，但早期详细指令可能丢失。持久规则应放进 CLAUDE.md。若巨大工具输出使上下文在摘要后立即再次填满，自动压缩会在数次尝试后停止并报错。[How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up)

该页没有公开一个适用于所有模式和模型的精确触发水位、压缩目标或缓存命中保证；本研究不推测这些数值。

### Codex：前缀契约与显式压缩边界

固定提交 `c3d3b142d10f4316b46e35aad7e5317e7e506cb7` 的测试同时检查缓存 key 不变、旧 input 与新 input 的前缀一致、配置更新追加到后面。这说明 key 稳定不够，投影内容也要稳定。[prompt caching test](https://github.com/openai/codex/blob/c3d3b142d10f4316b46e35aad7e5317e7e506cb7/codex-rs/core/tests/suite/prompt_caching.rs#L550-L565)

本地压缩实现生成 replacement history，并记录窗口及 `CompactedHistoryMetadata`。其中本地 fallback 对 user message 的 20k 保留上限，不能解释成全部 Codex 运行路径统一的压缩目标。[compact.rs](https://github.com/openai/codex/blob/c3d3b142d10f4316b46e35aad7e5317e7e506cb7/codex-rs/core/src/compact.rs#L383-L410)

### Pi：摘要 + 近期尾部，增量覆盖旧区间

固定提交 `42a3497d03ad17e308a2299fa824727894f2c0ec` 的文档给出：`contextTokens > contextWindow - reserveTokens` 触发，默认 reserve 16,384 token、`keepRecentTokens` 20,000 token。压缩 entry 保存 `firstKeptEntryId`，模型看到摘要和保留后缀；再压缩时基于上一摘要与新覆盖的区间，不是每轮重新总结全部原始历史。[compaction docs](https://github.com/earendil-works/pi/blob/42a3497d03ad17e308a2299fa824727894f2c0ec/packages/coding-agent/docs/compaction.md#L29-L49)、[重复压缩](https://github.com/earendil-works/pi/blob/42a3497d03ad17e308a2299fa824727894f2c0ec/packages/coding-agent/docs/compaction.md#L83)

摘要请求是一次性输入，当前实现以 `cacheRetention: "none"` 避免为它写入缓存；这不代表主对话关闭缓存。[summary request](https://github.com/earendil-works/pi/blob/42a3497d03ad17e308a2299fa824727894f2c0ec/packages/coding-agent/src/core/compaction/compaction.ts#L619-L632)

本项目安装的 `pi-coding-agent`/`pi-ai` 为 0.73.1；研究的 upstream SHA 不等于已安装 SDK。不能直接把新官方缓存能力或 upstream 行为视作生产已经启用。

### OpenClaw：最贴近个人 agent 的投影与记忆分工

固定提交 `4578c1dde1cb8b7217709845d091176e1d2cccc5` 的文档区分两条路径：直接 Anthropic API-key 请求交给服务端清理；代理、OAuth 等适用路径在客户端按 TTL 裁剪。客户端只有在 TTL 过期且容量条件满足时才开启新裁剪；裁剪后的内容记录成投影，后续工具循环、跨轮、重启都复用相同字节。原始工具结果不被改写。[session pruning](https://github.com/openclaw/openclaw/blob/4578c1dde1cb8b7217709845d091176e1d2cccc5/docs/concepts/session-pruning.md#L27-L98)

这里保护最近三轮 assistant turn 和 bootstrap 读取，仅工具结果参与裁剪；普通对话仍留在历史中。**“保护三轮”与“只恢复三轮”是不同策略。**[保护范围](https://github.com/openclaw/openclaw/blob/4578c1dde1cb8b7217709845d091176e1d2cccc5/docs/concepts/session-pruning.md#L100-L102)

手动 compaction 默认 `keepRecentTokens: 20000`；safeguard 路径会重新提炼旧摘要加新内容，并保留近期后缀。具体路径存在差异，不能把其中一个默认值当成所有 Provider 的通用水位。[compaction reference](https://github.com/openclaw/openclaw/blob/4578c1dde1cb8b7217709845d091176e1d2cccc5/docs/reference/session-management-compaction/compaction.md#L92-L107)

其长期记忆 `MEMORY.md` 是精简的持久事实、决定和短摘要，不是 exhaustive archive；daily notes 可检索，不在每轮全部注入。压缩前有 memory flush，使用私有会话副本，整理消息不进入之后的用户上下文。[memory 分层](https://github.com/openclaw/openclaw/blob/4578c1dde1cb8b7217709845d091176e1d2cccc5/docs/concepts/memory.md#L42-L62)、[memory flush](https://github.com/openclaw/openclaw/blob/4578c1dde1cb8b7217709845d091176e1d2cccc5/docs/concepts/memory.md#L229-L243)

## 对 nailong bot 的候选设计

以下是根据上述证据提出的设计建议，尚未确认具体规格。

1. **保留 Runtime Event Log → Context Projection 架构。** 原始事件及工具档案负责审计和追溯；活动投影负责给模型提供合法、有界、稳定的输入。当前 [ADR-0003](../adr/0003-recent-turn-context.md) 的三轮选择及跨轮恢复全文需要作为一项职责变更讨论，而非随手改一个轮数。
2. **优先固定跨轮工具投影。** 工具结果首次发送时确定 bounded view，后续按同一 ID 复用相同字节；全文通过显式读取恢复。必须保留 tool pairing、Provider continuation、删除/遗忘和 reset 隔离。活动记忆召回也以有出处的追加片段进入，避免每轮改写前缀或重复注入旧快照。
3. **活动上下文按预算追加，批量释放空间。** 触发水位与压缩目标分开，保护未完成事项、仍有效约束和近期尾部。压缩后固定摘要与切点；累计足够新内容再压下一次。阈值应由实际输入组成、模型窗口、输出/工具预留、费用与延迟测定，暂不将 60k→30k 等示意值写成默认。
4. **Akasha 管长期事实与按需召回。** 活动摘要保存当前事项和可追溯引用，原始日志保存详情；Akasha 不无差别塞回刚压掉的历史。还需决定记忆提取、去重、更新/遗忘与未完成事项的责任方。
5. **处理压缩无进展。** 记录释放量和剩余空间；若巨大工具结果导致连续立即重触发，优先处理该结果大小，并限制同一边界的无效重试。只递归摘要而不腾出空间不能解决问题。

可以把连续聊天划为多个内部活动区间，每个区间的摘要和历史前缀保持稳定，压缩时换一次区间。用户仍使用同一对话，无需显式切窗口；这是一种内部投影版本管理，不是无限缓存。

## 如何验收，避免只把百分比做高

建议基于同一真实事件序列比较当前策略与候选策略，并按交互密集段、压缩后首轮和空闲后首轮分组：

- 至少连续五轮，超过当前三轮窗口；检查每轮首次模型调用的最长共同前缀及未命中 token，工具循环的高命中不能掩盖跨轮首次调用。
- 工具结果从当前轮进入历史轮时，bounded view 保持不变；显式恢复全文应作为新增读取；重启后相同事件重建的请求字节、ID 和顺序稳定。
- 压缩只覆盖明确区间，tool call/result 不跨切点；测压缩后首轮的损失及随后稳态复用；验证摘要冻结且未完成任务、有效约束、原始证据仍可恢复。
- 空闲超过端点实际 TTL 后再聊，与 TTL 内的场景分开；缓存仍可自然冷启动。不建议仅为高命中率定时发付费 heartbeat 保活，收益需要实验。
- 对 memory 连续召回做去重检查，防止摘要、历史快照和 Akasha 同时携带同一事实。
- 同时记录总输入、缓存读/写、未命中输入、摘要调用费用、TTFT/整轮延迟、压缩间隔与释放量。若端点提供新 usage 字段，应先验证语义；不能凭当前报表断言生产漏记缓存写入。

## 仍需验证或决定

### 2026-10-10 只读容量测量

实际执行 `node --import tsx "$env:TEMP/nailong-budget-replay-20261010.mts"`。数据库使用 `DatabaseSync` 的只读模式，归档恢复不传修复来源；未加载 `.env`、未调用模型、未修改生产数据。脚本为临时诊断，不作为项目命令或实现验收入口。

截图五轮的 Provider 输入总量依次为 22,660、22,437、22,360、224,495（八次调用）、44,116；全部摘要调用为零。在最后一轮首次调用前，用现有四轮选择器重建 29 条消息和七个工具结果。历史全文工具正文为 68,463 bytes，按已记录首次模型可见策略固定投影为 36,167 bytes；messages-only 估算从 43,986 降至 33,221，差 10,765。每轮当前记忆引用的单独估算为 4,026–4,063。

初始可配置候选为有效硬输入预算的 70% 触发、40% 目标，近期原文 allowance 20,000、摘要上限 4,000。基础预算 110,080 时为 77,056 → 44,032；样本实际有效预算 105,945 时为 74,161 → 42,378。完整请求须计入固定提示词、工具 schema、记忆及输出预留；近期尾部和摘要 allowances 不保证无条件全部装入。

局限：这是既有四轮选择器的容量回放和稳定工具视图的反事实对比，并非新连续上下文实现回放。消息估算不包含固定工具 schema，采用 UTF-8/3；记录的 projection 与 Provider 实际输入还存在后续记忆注入及编码差异。未模拟摘要，不能据此声称摘要质量、真实压缩间隔、费用或延迟已经改善。初始值需在实现阶段按完整请求和长序列验收。已确认讨论结论见 [#125](https://github.com/CxHsin/nailong-bot/issues/125)。

### 实现阶段验证

- 自定义 Provider 是否支持官方缓存点、真实 TTL、缓存诊断和 compaction；SDK 0.73.1 与端点实际协议的交集是什么。
- 当前工具结果膨胀与记忆快照重复各自占多少新增 token；稳定投影单独能改善多少，取消三轮窗口再改善多少。
- 活动预算、尾部预算、摘要上限以及压缩后要保证的空余空间；需要用成本和延迟样本确定。
- 个人 agent 的未完成事项如何完成、取消或过期；哪类事实由 Akasha 长期保存，哪类必须继续出现在活动摘要中。

公开材料不能证明 ChatGPT、Claude 网页产品或其他闭源产品具有某个统一的无限对话缓存算法或精确水位。本报告仅把官方 API 能力、明确公开的产品行为和固定源码策略分别作为证据。
