# Nailong Agent

在本机运行的个人 Agent，通过 Telegram 私聊或 CLI 接收文字和图片，使用 pi SDK 调用 DeepSeek，并提供本机文件工具和可选的 TinyFish 网页工具。

[功能地图](#功能地图-feature-map) · [启动与使用](#启动与使用) · [运行数据与上下文](#运行数据与上下文) · [长期记忆](#长期记忆) · [代码结构](#代码结构) · [验证](#验证)

## 功能地图 Feature Map

这份地图按当前入口的接入状态组织。**入口已接入**表示启动命令会使用该能力；**模块已实现，待接入**表示有独立 API 和测试，但当前 Telegram／CLI 入口尚未完成集成；**兼容实现**表示保留在原应用流程中，不代表当前入口具备相同行为。

### 入口已接入

| 功能 | 当前行为与使用方式 | 代码入口 | 相关验证 |
| --- | --- | --- | --- |
| Telegram 私聊 | `npm start`；只接受配置账号的私聊文字和照片，照片先下载再归一化 | [`src/main.ts`](src/main.ts)、[`telegram-input.ts`](src/telegram/telegram-input.ts) | [`telegram-images.test.ts`](test/telegram-images.test.ts) |
| CLI 对话 | `npm run chat` 逐行交互；`npm run send -- "问题"` 单次发送；send 支持 `--image` | [`src/cli/main.ts`](src/cli/main.ts)、[`cli-channel.ts`](src/cli/cli-channel.ts) | [`cli-channel.test.ts`](test/cli-channel.test.ts) |
| 统一输入与运行 | 两个入口都用 Host API；输入携带 Actor、conversationId 和文字／图片 Content Parts，返回有序 RunHandle 事件；同一 Host 实例内串行执行 | [`host.ts`](src/host/host.ts)、[`content-parts.ts`](src/host/content-parts.ts) | [`host.test.ts`](test/host.test.ts) |
| Telegram 排版与交付 | 运行进展更新原生草稿，成功后发送最终正文；优先 Rich Markdown，API 不可用时回退安全 HTML 和长文分段 | [`src/channel/telegram/`](src/channel/telegram/index.ts)、[`rich-transport.ts`](src/channel/telegram/rich-transport.ts) | [`telegram-channel.test.ts`](test/telegram-channel.test.ts)、[`telegram-rich-transport.test.ts`](test/telegram-rich-transport.test.ts) |
| CLI 输出 | 默认显示运行时间线；`--json`／`--ndjson` 输出逐行 JSON 事件，带 type、seq、runId 和 conversationId；入口错误写 stderr | [`cli-channel.ts`](src/cli/cli-channel.ts) | [`cli-channel.test.ts`](test/cli-channel.test.ts) |
| 文件与网页工具 | pi 的 read、write、edit、ls、find、grep；配置 TinyFish 后增加 web_search、web_fetch | [`pi-agent.ts`](src/agent/pi-agent.ts)、[`tinyfish.ts`](src/agent/tinyfish.ts) | [`local-files.test.ts`](test/local-files.test.ts)、[`tinyfish.test.ts`](test/tinyfish.test.ts) |
| 运行日志与归档 | SQLite 追加记录输入、模型步骤、工具事实和运行结果；旧 JSONL 幂等导入；大工具结果完整归档，可分段读取 | [`sqlite-runtime-log.ts`](src/runtime/sqlite-runtime-log.ts)、[`tool-archive.ts`](src/runtime/tool-archive.ts)、[`archive-read.ts`](src/agent/archive-read.ts) | [`sqlite-runtime-log.test.ts`](test/sqlite-runtime-log.test.ts)、[`runtime-log.test.ts`](test/runtime-log.test.ts) |
| 模型执行与上下文预算 | 校验 status／result／final 输出协议，重放历史与工具结果，按窗口预算生成摘要 checkpoint，遇到协议错误或持续停滞时结束本轮 | [`execution.ts`](src/agent/execution.ts)、[`projection.ts`](src/context/projection.ts)、[`context-budget.ts`](src/context/context-budget.ts) | [`integration.test.ts`](test/integration.test.ts)、[`projection.test.ts`](test/projection.test.ts) |

“相关验证”指对应模块或兼容流程的测试；完整入口行为还需要按[验证](#验证)章节检查。

### 模块已实现，待接入

| 功能 | 已有模块能力 | 当前接入边界 | 相关验证 |
| --- | --- | --- | --- |
| conversationId 续聊 | Telegram 映射为 `telegram:private:<用户 ID>`；CLI 接受 `--conversation-id`，默认使用 `cli:<Actor ID>` | 身份已写入事件；现行模型历史重放尚未按 conversationId 隔离，不能据此承诺独立会话或完整跨 Channel 续聊 | [`cross-channel.test.ts`](test/cross-channel.test.ts) |
| reset 与取消 | Host 提供排队的 reset barrier 和独立 cancel API | 当前入口没有将 `/reset` 或终端取消接到这些 API；运行中取消还需要执行器响应 AbortSignal | [`host.test.ts`](test/host.test.ts) |
| 语义进展 | 区分 Provider 摘要、commentary、工具事实、阻塞、恢复与终态；提供 quiet／normal／verbose 和默认 15 秒静默提示 | 当前入口尚未调用 Progress pipeline；模型文字／工具事件没有完整转成 Channel 进展 | [`progress.ts`](src/runtime/progress.ts)、[`progress-pipeline.test.ts`](test/progress-pipeline.test.ts) |
| Delivery facts | 分开推导 Run 与 Delivery 状态，记录尝试、成功、拒绝、未知结果和显式重试 | 当前入口尚未使用该 fact store；交付去重、未知结果处理和有界重试尚未形成统一流程 | [`delivery-pipeline.ts`](src/runtime/delivery-pipeline.ts)、[`progress-pipeline.test.ts`](test/progress-pipeline.test.ts) |
| 结果复用与恢复 | Host 的 redeliver 按 resultId 读取已成功结果，不调用执行器；recoverRuns 从日志推导运行状态 | 尚无 Telegram／CLI 用户命令，也未在启动时自动核对未完成运行和交付 | [`recovery.ts`](src/host/recovery.ts)、[`host.test.ts`](test/host.test.ts) |
| Provider-aware Context Projection | ContextItem union 与 capabilities；过滤 UI-only 内容、按元数据选择 reasoning、检查图片支持，生成 cache identity、配置更新和 compaction summary | pi 当前仍调用现行 projection／context-budget；新投影尚未接入实际 Provider 请求与 compaction 生命周期 | [`provider-aware.ts`](src/context/provider-aware.ts)、[`context-provider.test.ts`](test/context-provider.test.ts) |
| Akasha 长期记忆 | 原话搜索／续读、预算内自动召回、embedding 缓存、历史初始化、送达后学习及持久遗忘 | 当前 Host 入口未写入记忆所需的 chatId，也未接入记忆命令与送达后学习；保留在原应用兼容流程，配置不代表功能已启用 | [`memory.test.ts`](test/memory.test.ts)、[`memory-dynamics.test.ts`](test/memory-dynamics.test.ts) |

Host／Channel 后续集成目标见 [规格 #60](https://github.com/CxHsin/nailong-bot/issues/60)；Akasha 记忆规格见 [#49](https://github.com/CxHsin/nailong-bot/issues/49)。模块测试通过与入口验收完成是两个不同状态。

### 兼容实现

| 功能 | 保留的行为 | 所在位置 |
| --- | --- | --- |
| 原 Telegram 应用流程 | 按聊天／消息 ID 去重，命令进入串行队列，支持 `/reset` 和 `/prompt` 查看／设置／恢复 | [`src/application/app.ts`](src/application/app.ts)、[`commands.ts`](src/application/commands.ts) |
| 原 Telegram 文字投影与恢复 | 模型快照流式草稿、阶段成果和最终正文分段；持久化投递计划；明确拒绝重试，未知送达不自动重发，重启核对已确认内容 | [`src/telegram/telegram-projection.ts`](src/telegram/telegram-projection.ts)、[`telegram-delivery.ts`](src/telegram/telegram-delivery.ts) |
| Akasha 记忆命令与学习 | `/forget`、`/memory log`、来源排除及送达后学习；当前 Host 入口尚未调用 | [`memory-commands.ts`](src/application/memory-commands.ts)、[`memory-learning.ts`](src/application/memory-learning.ts) |
| 配置与旧事件兼容 | 接受 TELEGRAM_* 环境变量并提示迁移；旧日志保留原记录，读取时做 additive upcast | [`src/channel/telegram/index.ts`](src/channel/telegram/index.ts)、[`event-envelope.ts`](src/host/event-envelope.ts) |

原应用和文字投影仍有回归测试，当前 `src/main.ts` 使用新的 Host Channel 路径；原流程中的命令、去重和恢复能力需要逐项迁入新入口。

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

可用 `AGENT_DATA_DIR` 指定运行数据目录（默认 `data/`），`AGENT_PROMPT_FILE` 指定提示词文件（默认 `system-prompt.md`），`AGENT_ACTOR_ID` 指定 CLI Actor（默认 `cli`）。当前 `cli:<Actor ID>` 是固定默认身份，可用 `--conversation-id` 指定不同身份；历史隔离状态见功能地图。

## 运行数据与上下文

Runtime Event Log 是持久运行事实源。生成结果、Channel 展示与交付确认分别记录；模型 Projection 与 UI Projection 从日志构造各自视图。投影和摘要不改写原始历史。

| 数据 | 默认路径 | 用途 |
| --- | --- | --- |
| 运行事实 | `data/events.sqlite` | 用户输入、模型步骤、工具派发／结果、运行终态及交付记录 |
| 旧事件日志 | `data/events.jsonl` | 启动时校验并幂等导入 SQLite，原文件保留 |
| 工具结果归档 | `data/tool-results/` | 完整工具输出及校验信息，供 read 分段取回 |
| 记忆与向量索引 | `data/memory.sqlite`、`data/embeddings.sqlite` | Akasha 兼容流程的派生缓存，可由原始事实和 embedding 服务重建 |
| 历史摘要 | `data/checkpoints/` | 经来源校验的有损上下文投影，原始事件仍可核查 |

现行 pi 路径使用 `src/context/projection.ts` 与 `context-budget.ts`。每次调用估算输入大小，默认预算为模型窗口的 86%；超过预算时折叠较早的完整历史，尽量保留最近三个完整请求。最终答复按交付事实回放；部分 progress／status 文字仍会进入现行上下文。新 Provider-aware 投影的 UI-only 排除策略尚待接入。

`createPiAgent` 支持 contextBudgetRatio／modelBudgetRatios 参数；Telegram 入口读取 `.env.example` 中的 `PROJECTION_BUDGET_RATIOS`，CLI 入口目前使用默认预算。

执行协议要求模型输出 status、result 或 final JSON；长文字可用追加帧。运行层校验格式、持久化模型和工具事件，纠正协议错误，并用停滞保护限制持续无进展的调用。当前 Channel 入口没有接入模型文字的 onText 回调，因此完整流式成果展示仍属于兼容投影流程。

`.env`、`data/` 和 `tinyFish.txt` 被 Git 忽略；运行数据可能包含图片、私人文件和工具参数。

## 本机文件工具

模型可以调用 read、write、edit、ls、find、grep；write 可覆盖文件。文件访问使用 Agent 进程的系统权限，相对路径按 pi 会话工作目录（默认 `data/`）解析。程序资源、默认提示词和受保护运行存储由工具访问策略保护；未开放 bash 工具。

默认笔记目录在 `system-prompt.md` 中约定，也可在请求里指定路径。文件工具不依赖 TinyFish；TinyFish 未配置或连接失败时，文件功能仍可用。find／grep 使用 pi 管理的 fd／ripgrep，缺失时 pi 会尝试下载。

## 长期记忆

本节描述 Akasha 模块和原应用兼容流程。当前 Host 入口未写入记忆所需的 `chatId` 身份，尚未启用 `memory_search`／`memory_read`、自动召回和初始化；送达后的记忆学习、`/forget` 与 `/memory log` 也未接入。Telegram 保留 embedding、记忆动力学、召回及预算配置，CLI 尚未读取这些配置。不能据此承诺当前启动命令具备完整长期记忆。

回复目标 User 或已送达 Assistant 消息发送 `/forget`，或发送 `/forget 节点引用`，可排除指定旧轮次的召回、学习与后续上下文。回复时也支持明确的“忘掉这件事”；模糊话题只列候选等待确认，问句不会执行遗忘。旧摘要失效重建，来源工具结果及其归档续读不能绕过排除。排除事实持久保存，重启、重建及 `/reset` 不会撤销；同话题的新消息仍可成为新记忆，不建立永久话题黑名单。

遗忘不是数据删除：原始运行日志和工具归档保留。明确发送 `/memory log 节点引用 [字符位置]` 可分段诊断查阅原话（每段最多 1800 Unicode 字符），不调用模型、不恢复记忆、不参与强化。普通记忆工具默认过滤已排除来源。

私聊 Agent 可用 `memory_search` 搜索中文或混合专名，再用 `memory_read` 按节点及消息引用分段读取原话。节点保存 User 与确认送达的 Assistant 正文来源，不包含状态、草稿和未送达文字。`/reset` 不删除长期记忆，`data/memory.sqlite` 是可由运行日志重建的派生索引，不是另一份运行事实源。查询本身不会强化记忆。

每次请求自动召回一次，编排层与当前对话按消息身份去重。自动注入的原文与来源包装总额不超过 4,096 个估算 token，且不超过输入预算的 10%；长节点使用连续原文片段，可继续读完整来源。候选快照和实际展示引用写入运行日志，工具循环不会重新召回。

可选配置 `EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、`EMBEDDING_API_KEY`，使用独立的 OpenAI 兼容 embeddings 服务；地址填写到 `/v1` 等基础路径，不包含 `/embeddings`。`EMBEDDING_TIMEOUT_MS` 默认 3000，超时或服务错误降级为本地字面查询，后台逐步补齐向量。向量缓存位于 `data/embeddings.sqlite`，按服务、模型和预处理版本隔离；不完整配置时不启用语义召回。密钥不写入运行日志。

`akasha-v1` 只强化自动融合排名前八个且确实展示原话的节点，不以工具补查的第九名补位。请求结束并确认至少一段成果或最终正文完整送达后，先追加 `memory_learned` 事实，再重放图状态；重启补提交不会重复学习。纯查询不扣资源，排序分数不是概率，学习增量使用有界单调映射。节点强度、边权的指数时间常数分别为 7 天、14 天，短期资源按 30 分钟时间常数恢复，不是半衰期；原话不会因自然衰减删除。

局部微图取种子原始时间前后 30 分钟的已存在节点（最多 256），最多 16 个内容/新颖度种子，每节点最多 8 条归一化强边，重启率 0.3，扩散 8 轮。远场另沿每个种子的全图一跳发现背景，不受局部时间窗口限制；多路径可累计，来源标为 `local`/`far` 并附节点路径。内容与图证据饱和到非负区间后统一融合，再加新颖度/长期状态、角色与路径修正和反 hub 惩罚；固定图信号下内容增强单调，不保证任意查询改变后排名不变。关联仅是背景，不是世界因果证明；直接找回保留资源低时的非零通道。

首次正常请求固定此前历史边界并在后台初始化。每轮只看当时已知的原始事件前缀，以原始时刻运行同一召回、引文预算和 top-8/展示交集；模拟标为 `historical`，不冒充旧模型真实使用。历史上下文采用 `bounded-original-replay`：重放原始完整步骤，超预算按完整旧请求缩短安全尾部，不读取今天的上下文摘要缓存；注入仍走同一预算合并器。初始化不生成新的用户画像，也不重新模拟已有真实学习；进度、初始化基线和学习事实保存于运行日志，重启续接，不把旧节点当作今天出生。配置 embedding 时等待后台补齐必要向量而非阻塞聊天；未配置则明确使用字面/零新颖度降级。

## 代码结构

| 目录／入口 | 职责 |
| --- | --- |
| `src/main.ts`、`src/cli/main.ts` | Telegram／CLI 配置、依赖装配、启动与关闭 |
| `src/host/` | Actor／ContentPart 输入契约、RunHandle、串行队列、cancel／reset API、结果复用与恢复视图 |
| `src/channel/telegram/`、`src/cli/` | Channel 输入归一化和输出投影；Telegram Rich Markdown／HTML transport |
| `src/agent/` | pi 会话、结构化执行协议、工具事实记录、访问策略与 TinyFish |
| `src/context/` | 现行历史重放、预算、checkpoint 和工具结果视图，以及待接入的 Provider-aware 投影 |
| `src/memory/` | Akasha 原话索引、embedding、缓存、关联图、动力学与召回 |
| `src/runtime/` | SQLite／JSONL 日志、归档、增量读取，以及 Progress／Delivery facts 模块 |
| `src/application/`、`src/telegram/` | 原应用兼容流程、命令、去重、Telegram 输入／排版及旧文字投影与恢复 |
| `test/` | Host、Context、Channel 模块测试及兼容流程回归测试 |

## 验证

代码检查：`npm run typecheck`、`npm test`、`npm run build`。完整集成回归可串行运行 `node --import tsx --test --test-concurrency=1 test/*.test.ts`，避免短时间窗测试受并行 SDK 负载影响。文档修改核对功能地图中的路径、启动命令与接入状态即可。

Akasha 兼容流程的配置、初始化与故障重建见 [操作与诊断](docs/memory-operations.md)；dense 对照、错误关联及复现命令见 [对照验收](docs/memory-evaluation.md)。

配置真实凭据后，分别检查 Telegram 文字／图片、Markdown 正文与草稿、CLI chat／send、图片输入、JSON 输出和文件／网页工具。断言跨 Channel 续聊、命令、取消、流式成果及重启交付恢复前，还需要补齐功能地图所列的入口集成与验收；独立模块和兼容流程的测试不能替代这一步。
