# Nailong bot

在本机运行的个人 Agent，通过 Telegram 私聊或 CLI 接收文字和图片，使用 pi SDK 调用 DeepSeek，并提供本机文件工具和可选的 TinyFish 网页工具。

[功能地图](#功能地图-feature-map) · [启动与使用](#启动与使用) · [运行数据与上下文](#运行数据与上下文) · [长期记忆](#长期记忆) · [代码结构](#代码结构) · [验证](#验证)

## 功能地图 Feature Map

这份地图按当前入口的接入状态组织。**入口已接入**表示启动命令会使用该能力；**模块已实现，待完整接入**表示有独立 API 和测试，但当前 Telegram／CLI 入口仍有集成边界；**兼容实现**表示保留在原应用流程中，不代表当前入口具备相同行为。Telegram 和 CLI 都通过 `createAgentHost` 装配命令、会话日志与送达后学习。

### 入口已接入

| 功能 | 当前行为与使用方式 | 代码入口 | 相关验证 |
| --- | --- | --- | --- |
| Telegram 私聊 | `npm start`；只接受配置账号的私聊文字和照片，照片先下载再归一化 | [`src/main.ts`](src/main.ts)、[`telegram-input.ts`](src/telegram/telegram-input.ts) | [`telegram-images.test.ts`](test/telegram-images.test.ts) |
| CLI 对话 | `npm run chat` 逐行交互；`npm run send -- "问题"` 单次发送；send 支持 `--image` | [`src/cli/main.ts`](src/cli/main.ts)、[`cli-channel.ts`](src/cli/cli-channel.ts) | [`cli-channel.test.ts`](test/cli-channel.test.ts) |
| 统一输入与运行 | 两个入口都用 Host API；输入携带 Actor、conversationId 和文字／图片 Content Parts，返回有序 RunHandle 事件；同一 Host 实例内模型任务串行执行，只读缓存查询独立处理 | [`host.ts`](src/host/host.ts)、[`content-parts.ts`](src/host/content-parts.ts) | [`host.test.ts`](test/host.test.ts) |
| 会话隔离与跨 Channel 续聊 | 历史、提示词设置、摘要 checkpoint 和记忆按 conversationId 隔离；共用数据目录时，CLI 指定 Telegram 的 conversationId 可继续同一会话 | [`agent-host.ts`](src/application/agent-host.ts)、[`conversation-log.ts`](src/runtime/conversation-log.ts) | [`agent-host.test.ts`](test/agent-host.test.ts)、[`cache-provider.test.ts`](test/cache-provider.test.ts)、[`command-channels.test.ts`](test/command-channels.test.ts) |
| 共享控制命令 | Telegram／CLI 支持 `/help`、`/kvcache`、`/reset`、`/prompt`、`/forget`、`/memory log`；修改命令进入串行队列，/kvcache 即时读取快照，均不调用模型；Telegram 启动时同步账号专属命令菜单 | [`agent-host.ts`](src/application/agent-host.ts)、[`host-channel.ts`](src/channel/telegram/host-channel.ts) | [`agent-host.test.ts`](test/agent-host.test.ts)、[`command-channels.test.ts`](test/command-channels.test.ts) |
| Telegram 排版与交付 | 模型进展、正文预览和工具活动合并更新一个原生草稿；成功后发送阶段成果与最终正文，失败时发送可见错误回复；优先 Rich Markdown，API 不可用时回退安全 HTML 和长文分段 | [`projection.ts`](src/channel/telegram/projection.ts)、[`rich-transport.ts`](src/channel/telegram/rich-transport.ts) | [`telegram-channel.test.ts`](test/telegram-channel.test.ts)、[`telegram-rich-transport.test.ts`](test/telegram-rich-transport.test.ts)、[`ui-projection.test.ts`](test/ui-projection.test.ts) |
| 实时进展 | 模型提供简短说明，运行时提供工具开始／完成／失败事实；Host 有序转发，Telegram 默认每 250ms 合并更新，短任务直接给答案；草稿失败不阻断最终交付 | [`progress.ts`](src/runtime/progress.ts)、[`agent-host.ts`](src/application/agent-host.ts)、[`projection.ts`](src/channel/telegram/projection.ts) | [`ui-projection.test.ts`](test/ui-projection.test.ts)、[`telegram-channel.test.ts`](test/telegram-channel.test.ts) |
| CLI 输出 | 默认显示运行时间线；`--json`／`--ndjson` 输出逐行 JSON 事件，带 type、seq、runId 和 conversationId；入口错误写 stderr | [`cli-channel.ts`](src/cli/cli-channel.ts) | [`cli-channel.test.ts`](test/cli-channel.test.ts) |
| 文件与网页工具 | pi 的 read、write、edit、ls、find、grep；配置 TinyFish 后增加 web_search、web_fetch | [`pi-agent.ts`](src/agent/pi-agent.ts)、[`tinyfish.ts`](src/agent/tinyfish.ts) | [`local-files.test.ts`](test/local-files.test.ts)、[`tinyfish.test.ts`](test/tinyfish.test.ts) |
| 运行日志与归档 | SQLite 追加记录输入、模型步骤、工具事实和运行结果；旧 JSONL 幂等导入；大工具结果完整归档，可分段读取 | [`sqlite-runtime-log.ts`](src/runtime/sqlite-runtime-log.ts)、[`tool-archive.ts`](src/runtime/tool-archive.ts)、[`archive-read.ts`](src/agent/archive-read.ts) | [`sqlite-runtime-log.test.ts`](test/sqlite-runtime-log.test.ts)、[`runtime-log.test.ts`](test/runtime-log.test.ts) |
| 送达记录与记忆学习 | Telegram 正文发送成功、CLI 输出成功后记录 `delivery_succeeded`；模型运行随后结算记忆，重复确认不重复学习；命令回复不参与学习 | [`agent-host.ts`](src/application/agent-host.ts)、[`memory-learning.ts`](src/application/memory-learning.ts) | [`agent-host.test.ts`](test/agent-host.test.ts)、[`command-channels.test.ts`](test/command-channels.test.ts) |
| Akasha 长期记忆 | 两个入口启用 `memory_search`／`memory_read`、预算内自动召回、后台历史初始化与持久遗忘；Telegram 读取可选 embedding 配置，CLI 使用字面召回和默认记忆参数 | [`pi-agent.ts`](src/agent/pi-agent.ts)、[`memory-context.ts`](src/application/memory-context.ts)、[`memory-bootstrap.ts`](src/application/memory-bootstrap.ts) | [`memory.test.ts`](test/memory.test.ts)、[`memory-dynamics.test.ts`](test/memory-dynamics.test.ts)、[`cache-provider.test.ts`](test/cache-provider.test.ts) |
| Prompt cache 与用量统计 | 稳定 system／工具前缀，冻结每轮日期与记忆快照；`/kvcache` 查看最近五组模型运行的缓存详情，摘要等辅助调用单独统计 | [`execution.ts`](src/agent/execution.ts)、[`cache-statistics.ts`](src/runtime/cache-statistics.ts) | [`cache-provider.test.ts`](test/cache-provider.test.ts)、[`agent-host.test.ts`](test/agent-host.test.ts) |
| 回复缓存报表 | Telegram 明确回复已送达的 `/kvcache` 报表时，将持久记录中的报表快照作为模型背景，跨工具步骤保留；报表显示查询时数据，重新查询才更新 | [`reply-context.ts`](src/runtime/reply-context.ts)、[`projection.ts`](src/context/projection.ts) | [`reply-context.test.ts`](test/reply-context.test.ts) |
| 模型执行与上下文预算 | 接收普通 Markdown，结算进展与最终回答，重放历史与工具结果，按窗口预算生成摘要 checkpoint，遇到协议错误或持续停滞时结束本轮 | [`execution.ts`](src/agent/execution.ts)、[`projection.ts`](src/context/projection.ts)、[`context-budget.ts`](src/context/context-budget.ts) | [`integration.test.ts`](test/integration.test.ts)、[`projection.test.ts`](test/projection.test.ts) |

“相关验证”指对应模块或兼容流程的测试；完整入口行为还需要按[验证](#验证)章节检查。

### 模块已实现，待完整接入

| 功能 | 已有模块能力 | 当前接入边界 | 相关验证 |
| --- | --- | --- | --- |
| 取消 | Host 提供独立 cancel API，`/reset` 已作为排队控制命令接入 | 当前入口没有用户取消命令或终端取消映射；运行中取消还需要执行器响应 AbortSignal | [`host.test.ts`](test/host.test.ts)、[`agent-host.test.ts`](test/agent-host.test.ts) |
| 完整 Delivery pipeline | 分开推导 Run 与 Delivery 状态，记录尝试、成功、拒绝、未知结果和显式重试 | 当前入口已记录成功送达，但尚未接入统一的尝试／拒绝／未知结果流程、交付去重和有界重试 | [`delivery-pipeline.ts`](src/runtime/delivery-pipeline.ts)、[`delivery-pipeline.test.ts`](test/delivery-pipeline.test.ts) |
| 结果复用与恢复 | Host 的 redeliver 按 resultId 读取已成功结果，不调用执行器；recoverRuns 从日志推导运行状态 | 尚无 Telegram／CLI 用户命令，也未在启动时自动核对未完成运行和交付 | [`recovery.ts`](src/host/recovery.ts)、[`host.test.ts`](test/host.test.ts) |
| 完整 Provider-aware Context Projection | ContextItem union 与 capabilities；过滤 UI-only 内容、按元数据选择 reasoning、检查图片支持，生成 cache identity、配置更新和 compaction summary | cache identity 已接入实际 pi 执行；模型消息与压缩仍走现行 projection／context-budget，尚未整体切换到新投影 | [`provider-aware.ts`](src/context/provider-aware.ts)、[`context-provider.test.ts`](test/context-provider.test.ts)、[`cache-provider.test.ts`](test/cache-provider.test.ts) |

Host／Channel 集成规格见 [#60](https://github.com/CxHsin/nailong-bot/issues/60)；Akasha 记忆规格见 [#49](https://github.com/CxHsin/nailong-bot/issues/49)。表中测试覆盖模块和相应装配路径，真实 Telegram 客户端与 Provider 的使用效果仍需凭据验收。

### 兼容实现

| 功能 | 保留的行为 | 所在位置 |
| --- | --- | --- |
| 原 Telegram 应用流程 | 按聊天／消息 ID 去重，命令进入串行队列，支持 `/reset` 和 `/prompt` 查看／设置／恢复 | [`src/application/app.ts`](src/application/app.ts)、[`commands.ts`](src/application/commands.ts) |
| 原 Telegram 文字投影与恢复 | 模型快照流式草稿、阶段成果和最终正文分段；持久化投递计划；明确拒绝重试，未知送达不自动重发，重启核对已确认内容 | [`src/telegram/telegram-projection.ts`](src/telegram/telegram-projection.ts)、[`telegram-delivery.ts`](src/telegram/telegram-delivery.ts) |
| 自然语言遗忘意图 | 原应用支持明确回复“忘掉这件事”和模糊话题候选确认；当前 Host 仅路由斜杠控制命令，应使用 `/forget` | [`app.ts`](src/application/app.ts)、[`memory-commands.ts`](src/application/memory-commands.ts) |
| 配置与旧事件兼容 | 接受 TELEGRAM_* 环境变量并提示迁移；旧日志保留原记录，读取时做 additive upcast | [`src/channel/telegram/index.ts`](src/channel/telegram/index.ts)、[`event-envelope.ts`](src/host/event-envelope.ts) |

原应用和文字投影仍有回归测试，当前 `src/main.ts` 使用新的 Host Channel 路径；共享命令和 Telegram 消息 ID 去重已迁入，旧流程的流式成果展示、完整投递恢复与自然语言遗忘仍有接入边界。

## 启动与使用

需要 Node.js 24 或更新版本。

1. `npm install`。
2. 复制 `.env.example` 为 `.env`，填写 `DEEPSEEK_API_KEY`。Telegram 还需要 `AGENT_TELEGRAM_BOT_TOKEN` 和 `AGENT_TELEGRAM_USER_ID`，旧 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_USER_ID` 仍可使用。用户 ID 是 Telegram 数字 ID。
3. 按需要编辑 `system-prompt.md`；网页查询需要可选的 `TINYFISH_API_KEY`。
4. 选择下方入口。

| 使用方式 | 命令 |
| --- | --- |
| Telegram long polling | `npm start`，或兼容别名 `npm run agent` |
| CLI 逐行聊天 | `npm run chat` |
| CLI 单次提问 | `npm run send -- "帮我整理这段内容"` |
| 文字与图片 | `npm run send -- "分析这张图" --image photo.png` |
| 指定 conversationId | `npm run send -- "继续" --conversation-id telegram:private:42` |
| 机器可读事件 | `npm run send -- "问题" --ndjson` |

Telegram 使用 long polling，无需公网地址；只有进程运行时在线。CLI 使用同一 Host 实现，各启动进程持有自己的 Host 实例；队列只保证实例内串行。

可用 `AGENT_DATA_DIR` 指定运行数据目录（默认 `data/`），`AGENT_PROMPT_FILE` 指定提示词文件（默认 `system-prompt.md`），`AGENT_ACTOR_ID` 指定 CLI Actor（默认 `cli`）。Telegram 会话为 `telegram:private:<用户 ID>`，CLI 默认为 `cli:<Actor ID>`；不同 conversationId 的历史与记忆隔离。跨入口续聊需要使用同一数据目录和 conversationId。

Telegram 私聊和 CLI chat／send 共用以下纯文字命令；CLI 单次调用例如 `npm run send -- "/kvcache"`，附带 `--conversation-id` 可查询指定会话。

| 命令 | 行为 |
| --- | --- |
| `/help` | 查看命令帮助 |
| `/kvcache` | 即时查询最近五组运行的缓存快照；不调用模型 |
| `/reset` | 排队开始新上下文，保留原始记录、长期记忆与累计统计 |
| `/prompt`、`/prompt set 提示词`、`/prompt reset` | 查看、设置当前会话提示词，或恢复提示词文件中的默认值；下一请求生效 |
| `/forget 节点引用` | 持久排除指定旧轮次；Telegram 也可回复目标消息发送 `/forget` |
| `/memory log 节点引用 [字符位置]` | 分段诊断查阅原始轮次，不恢复记忆或参与强化 |

Telegram 启动时为配置账号注册命令菜单；菜单同步失败会报告错误并继续启动聊天。

## 运行数据与上下文

Runtime Event Log 是持久运行事实源。模型步骤、工具结果、运行终态与交付确认分别记录；模型 Projection 从日志构造上下文，实时 UI Projection 消费 Host 的活动流。草稿快照不另写日志，重启不重放旧草稿；投影和摘要不改写原始历史。

网页读取默认向 TinyFish 传 `ttl: 0`，优先获取新内容；显式指定 `ttl` 时保留该值，服务端仍可能依据源站缓存策略返回缓存。大型 `web_fetch` 结果按页展示 URL、短正文、有限长文预览、页面链接和逐 URL 错误；短页优先于长文预览，总呈现预算有界。模型可用给出的 `read` 入口按页读取完整正文与链接，或直接读取网页归档获取全部页面的可读文本；原始响应仍完整保存，其他工具的 JSONL 归档行为保持不变。历史工具投影按记录的版本重放。验证与真实模型对照见 [网页结果验收](docs/web-result-acceptance.md)。

| 数据 | 默认路径 | 用途 |
| --- | --- | --- |
| 运行事实 | `data/runtime-v2.sqlite` | 用户输入、模型步骤、工具派发／结果、运行终态及交付记录；停旧 Bot 后运行 `npm run migrate` 备份迁移，旧库保留 |
| 旧事件日志 | `data/events.jsonl` | 启动时校验并幂等导入 SQLite，原文件保留 |
| 工具结果归档 | `data/tool-results/` | 完整工具输出及校验信息，供 read 分段取回 |
| 记忆与向量索引 | `data/memory.sqlite`、`data/embeddings.sqlite` | 当前 Akasha 记忆的派生缓存，可由原始事实和 embedding 服务重建 |
| 历史摘要 | `data/checkpoints/` | 经来源校验的有损上下文投影，原始事件仍可核查 |

现行 pi 路径使用 `src/context/projection.ts` 与 `context-budget.ts`。每次调用估算输入大小，默认预算为模型窗口的 86%；超过预算时折叠较早的完整历史，尽量保留最近三个完整请求。Host 会话回放包含已结算进展与有效运行摘要，保留工具事实和成功模型运行的最终答复；过程说明不进入 Akasha；送达确认另行记录。完整 Provider-aware 消息投影仍待接入。

system 提示词与工具定义保持稳定，当前日期及自动记忆引文按轮次冻结为 `context_input_snapshot`，后续工具步骤和压缩复用该快照。Provider-aware cache identity 已用于 pi 会话标识；实际 DeepSeek 请求过滤其不支持的缓存参数。`/kvcache` 根据日志中的 Provider usage 统计，缺失数据明确标注，摘要等辅助调用单独统计；统计不代表账单。Telegram 回复已送达缓存报表时会显式引用该查询快照。

`createPiAgent` 支持 contextBudgetRatio／modelBudgetRatios 参数；Telegram 入口读取 `.env.example` 中的 `PROJECTION_BUDGET_RATIOS`，CLI 入口目前使用默认预算。

生产执行器接收普通 Markdown：同一步中伴随工具调用的文字结算为进展，无工具调用的完整文字结算为最终回答。每段进展通过草稿流式展示后独立正式发送，最终答案另发。JSON 协议仅用于兼容旧入口。详见 [运行进展与迁移](docs/runtime-progress.md)。

旧 json-text-v2 兼容入口仍保留受限协议恢复和原始记录；新生产路径不要求 JSON 文字外壳。

文字对象与追加帧拒绝重复字段（包括转义后同名字段）。协议纠错反馈只进入当前 Run 的模型输入，不进入可复用历史摘要；旧投影策略的摘要缓存会重新生成，原始记录保留。多行预览和最终正文采用同一空白规范化规则。Telegram 草稿请求最多等待 3 秒，超时取消并停用本轮草稿更新，正式回复仍继续发送。见 [#80](https://github.com/CxHsin/nailong-bot/issues/80)。

UI Projection 显示短命草稿和工具活动，已结算说明逐段固定交付，最终答案独立。静默 15 秒且存在新事实时，独立只读模型补充运行摘要，两次至少间隔 60 秒、每轮最多 5 次；来源明确且不参与长期记忆。生产采用新事件库，全量迁移保留原库，重启只记录中断、不补发。见 [#83](https://github.com/CxHsin/nailong-bot/issues/83)。

`.env`、`data/` 和 `tinyFish.txt` 被 Git 忽略；运行数据可能包含图片、私人文件和工具参数。

## 本机文件工具

模型可以调用 read、write、edit、ls、find、grep；write 可覆盖文件。文件访问使用 Agent 进程的系统权限，相对路径按 pi 会话工作目录（默认 `data/`）解析。程序资源、默认提示词和受保护运行存储由工具访问策略保护；未开放 bash 工具。

默认笔记目录在 `system-prompt.md` 中约定，也可在请求里指定路径。文件工具不依赖 TinyFish；TinyFish 未配置或连接失败时，文件功能仍可用。find／grep 使用 pi 管理的 fd／ripgrep，缺失时 pi 会尝试下载。

## 长期记忆

Akasha 已接入当前 Telegram／CLI Host：按 conversationId 写入并筛选原始事件，启用 `memory_search`／`memory_read`、自动召回、后台历史初始化、送达后学习、`/forget` 和 `/memory log`。记忆范围由 conversationId 决定，指定同一身份可跨入口访问。Telegram 读取 embedding、记忆动力学、召回及预算配置；CLI 当前未读取这些可选配置，使用默认参数和本地字面召回。

Telegram 回复目标 User 或已送达 Assistant 消息发送 `/forget`，或在任一入口发送 `/forget 节点引用`，可排除指定旧轮次的召回、学习与后续上下文。`/forget 模糊话题` 只列候选等待明确选择；当前 Host 不将自然语言“忘掉这件事”作为遗忘控制命令。旧摘要失效重建，来源工具结果及其归档续读不能绕过排除。排除事实持久保存，重启、重建及 `/reset` 不会撤销；同话题的新消息仍可成为新记忆，不建立永久话题黑名单。

遗忘不是数据删除：原始运行日志和工具归档保留。明确发送 `/memory log 节点引用 [字符位置]` 可分段诊断查阅原话（每段最多 1800 Unicode 字符），不调用模型、不恢复记忆、不参与强化。普通记忆工具默认过滤已排除来源。

私聊 Agent 可用 `memory_search` 搜索中文或混合专名，再用 `memory_read` 按节点及消息引用分段读取原话。节点保存 User 与确认送达的 Assistant 正文来源，不包含状态、草稿和未送达文字。`/reset` 不删除长期记忆，`data/memory.sqlite` 是可由运行日志重建的派生索引，不是另一份运行事实源。查询本身不会强化记忆。

每次请求自动召回一次，编排层与当前对话按消息身份去重。自动注入的原文与来源包装总额不超过 4,096 个估算 token，且不超过输入预算的 10%；长节点使用连续原文片段，可继续读完整来源。候选快照和实际展示引用写入运行日志，工具循环不会重新召回。

Telegram 入口可选配置 `EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、`EMBEDDING_API_KEY`，使用独立的 OpenAI 兼容 embeddings 服务；地址填写到 `/v1` 等基础路径，不包含 `/embeddings`。`EMBEDDING_TIMEOUT_MS` 默认 3000，超时或服务错误降级为本地字面查询，后台逐步补齐向量。向量缓存位于 `data/embeddings.sqlite`，按服务、模型和预处理版本隔离；不完整配置时不启用语义召回，普通聊天与字面记忆仍可用。密钥不写入运行日志。

`akasha-v1` 只强化自动融合排名前八个且确实展示原话的节点，不以工具补查的第九名补位。当前 Host 在最终正文送达确认后追加 `request_completed` 并提交学习；兼容流程也支持阶段成果完整送达后的结算。学习先追加 `memory_learned` 事实，再重放图状态；补提交不会重复学习。纯查询不扣资源，排序分数不是概率，学习增量使用有界单调映射。节点强度、边权的指数时间常数分别为 7 天、14 天，短期资源按 30 分钟时间常数恢复，不是半衰期；原话不会因自然衰减删除。

局部微图取种子原始时间前后 30 分钟的已存在节点（最多 256），最多 16 个内容/新颖度种子，每节点最多 8 条归一化强边，重启率 0.3，扩散 8 轮。远场另沿每个种子的全图一跳发现背景，不受局部时间窗口限制；多路径可累计，来源标为 `local`/`far` 并附节点路径。内容与图证据饱和到非负区间后统一融合，再加新颖度/长期状态、角色与路径修正和反 hub 惩罚；固定图信号下内容增强单调，不保证任意查询改变后排名不变。关联仅是背景，不是世界因果证明；直接找回保留资源低时的非零通道。

首次正常请求固定此前历史边界并在后台初始化。每轮只看当时已知的原始事件前缀，以原始时刻运行同一召回、引文预算和 top-8/展示交集；模拟标为 `historical`，不冒充旧模型真实使用。历史上下文采用 `bounded-original-replay`：重放原始完整步骤，超预算按完整旧请求缩短安全尾部，不读取今天的上下文摘要缓存；注入仍走同一预算合并器。初始化不生成新的用户画像，也不重新模拟已有真实学习；进度、初始化基线和学习事实保存于运行日志，重启续接，不把旧节点当作今天出生。配置 embedding 时等待后台补齐必要向量而非阻塞聊天；未配置则明确使用字面/零新颖度降级。

## 代码结构

| 目录／入口 | 职责 |
| --- | --- |
| `src/main.ts`、`src/cli/main.ts` | Telegram／CLI 配置、依赖装配、启动与关闭 |
| `src/host/` | Actor／ContentPart 输入契约、RunHandle、串行队列、cancel／reset API、结果复用与恢复视图 |
| `src/channel/telegram/`、`src/cli/` | Channel 输入归一化和输出投影；Telegram Rich Markdown／HTML transport |
| `src/agent/` | pi 会话、结构化执行协议、工具事实记录、访问策略与 TinyFish |
| `src/context/` | 会话历史重放、预算、checkpoint、工具结果视图及部分接入的 Provider-aware 投影 |
| `src/memory/` | Akasha 原话索引、embedding、缓存、关联图、动力学与召回 |
| `src/runtime/` | SQLite／JSONL 日志、会话筛选、缓存统计、回复引用、归档、增量读取，以及 Progress／Delivery facts 模块 |
| `src/application/`、`src/telegram/` | 生产 Agent Host 装配、共享命令、记忆编排、去重、Telegram 输入／排版及原应用兼容投影与恢复 |
| `test/` | Host、Context、Channel 模块测试及兼容流程回归测试 |

## 验证

代码检查：`npm run typecheck`、`npm test`、`npm run build`。完整集成回归可串行运行 `node --import tsx --test --test-concurrency=1 test/*.test.ts`，避免短时间窗测试受并行 SDK 负载影响。文档修改核对功能地图中的路径、启动命令与接入状态即可。

Akasha 配置、初始化与故障重建见 [操作与诊断](docs/memory-operations.md)；其中自然语言遗忘和部分送达行为属于兼容流程，当前入口边界以本页功能地图为准。dense 对照、错误关联及复现命令见 [对照验收](docs/memory-evaluation.md)。

配置真实凭据后，分别检查 Telegram 文字／图片、Markdown 正文与草稿、CLI chat／send、图片输入、JSON 输出、文件／网页工具，以及同一 conversationId 的跨 Channel 续聊、共享命令和长期记忆。`/kvcache` 应在任务运行中及时返回，显示最近五组运行详情、待结算／缺失提示；Telegram 明确回复报表后，模型应能解释该查询快照。新 Runtime 已接入逐段进展、独立最终答案、静默摘要和启动只记录中断；真实客户端验收状态见 [验收记录](docs/runtime-progress-acceptance.md)，自动测试不能替代客户端验证。
