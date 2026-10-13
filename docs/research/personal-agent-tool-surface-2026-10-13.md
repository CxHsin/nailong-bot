# Personal agent 的工具面：调研与实验方案

2026-10-13。问题：当前主对话初始暴露约 13 个完整工具定义，是否有必要？初稿（`924c971`）做一手资料调研、仓库核验及实验设计，没有实测下述产品，也没有进行真实模型对照。产品资料只支持其公开描述，不支持推断内部完整工具清单。

同日后续：用户确认「基础工具 + skill/CLI，权限留在系统执行层」，要求先搭建隔离实验、验证后再迁移。现已加入 [A/D 接口融合实验](../../scripts/experiments/tool-surface/README.md)，复用真实 Pi/Host，默认本地预定调用夹具，共 12 次任务及 20 个测试；真实模型入口须显式启用。本页下述 13/5/3 设计保留为初稿历史，未进行其 9/60 次真实模型实验。实验搭建任务为 [#186](https://github.com/CxHsin/nailong-bot/issues/186)。

同日真实测试：[gpt-5.6-luna 的 20 次 A/D pilot 结果](personal-agent-tool-live-2026-10-13.md)。目标成果补充复核为 A 5/10、D 9/10，预定严格流程为 3/10、8/10；D 请求和累计 token 更多。原流程验收有假阴性，完整接口差异也不能独立归因于工具数量。

## 当前结论与证据边界

能力数量、入口数量、初始完整 schema 数量是三个问题。现有证据说明 personal agent 需要文件、执行、记忆及持续工作等能力；没有证据说明这些能力都必须初始常驻，也没有证据证明压缩到三种入口一定更好。应比较同一能力集合在不同暴露方式下的任务结果与总成本。

本仓库 ADR 将文件、Shell、记忆、委派、工作管理、发现及通知列为常驻候选，同时明确“不设固定工具数量指标”。这是接口决策，尚不是比较实验结论。[仓库来源 R1]

## 外部项目公开了什么

| 项目 | 可确认的公开设计 | 对本问题的启发与限制 |
| --- | --- | --- |
| Muse | 有 filesystem、terminal、完整 browser，能编写自己的 tools；后台任务会判断进展是否值得通知。[S1] | 通用执行入口承载多种能力，但没有公布完整初始 schema 或数量。 |
| Dots | 可使用云端 computer/browser、启用的 plugins、本地 computer、后台 agents/tasks、sleep/wake 及 saved notes。[S3] | 强调持续工作和跨环境能力；公开产品描述不能确定模型初始看见多少工具。 |
| Cue | 与 Manus 共享基础设施；专属 phone、wallet、computer、email，支持 connectors 和 routines，用户配置工具、权限及 review boundaries。[S5][S8] | 是较宽的个人行动能力面；公开资料未给出 Cue 的初始工具清单。 |
| Grok Bot | 有自己的 computer，可跨没有 API/MCP 的平台工作；支持 Cursor 同类 MCP servers、plugins、skills，以及 chat、带 triggers 的 routines、其他 bots 协作。[S4][S7] | computer 承载跨平台操作，内部仍可能具有多个工具；不能据此推断初始 schema 少。 |

Muse 的安全架构尤其说明：**通用入口可以承载许多独立实现**。内置 connector CLIs 主要解析参数、打开获准文件，通过 Unix socket 传递类型化参数及文件描述符；业务逻辑运行在隔离的 workers。Sentinel 独立裁决连接器动作和网络出口；browser 通过专用 subagent 与 broker 工作，子 Agent 读取 AX 树而不能执行页面 JavaScript。[S2] 这支持将能力封装到稳定入口的方向，却不支持用裸 `bash` 替代本仓库授权与动作账本；资料也没有给出 Muse 初始入口数量。

Grok Bot 官方指南还描述了独立 review agent 的允许、阻断、升级处理，自然语言 allow/block rules 和隔离环境；写代码时由 outer loop 整理 Slack、Notion、GitHub 背景，再交给 Cursor coding harness。[S7] 后者支持把个人助手的协调与编码执行分开考虑，但仍不能确定 outer loop 的完整工具列表，也不能证明这种分工比本仓库现状更好。

Manus 2.0 的 Cascade 在需要时引入专门能力。其发布文给出某配置下 token 降低 23.2%、时间降低 28.2%、成本降低 32% 的结果。[S5] 这些数字不是“减少常驻工具”的独立消融，不能归因于工具数量，也不能直接当作 Cue 接口实验结果。

Manus 2025 年的工程文章指出工具过多更容易误选，提出“遮蔽而非移除”，避免在循环中改变工具定义前缀影响缓存，并利用状态机约束可选动作。[S6] 这是历史工程经验，不能断言 2026 年 Cue 沿用相同实现。它与本仓库保持固定常驻前缀、通过原生发现记录加载专用 schema 的做法并不矛盾：稳定前缀和阶段性限定可用动作可以同时成立。

当前 OpenAI 官方工具搜索文档说明，动态加载可能降低整体 token 与成本，新增工具注入末尾以保留缓存。这里的“可能”需要实验验证。服务端搜索中的单个 deferred function 仍向模型显示名称和描述，主要推迟参数 schema；namespace/MCP 以容器名及描述暴露。客户端搜索则可以初始不声明整个工具目录，之后返回发现结果。[S9] 因而“按需加载”也有不同可见性，不能混用服务端和客户端工具计数；历史上保持前缀稳定的建议与当前原生动态发现并不冲突。

## 本仓库独立核验

基准为 `development`，提交 `de3664646caf7dd2a040165e8b0fc96436608346`。当主对话具有工作上下文并配置 memory 时：`task_control` + 7 个工作工具 + `delegate_work` + `complete_work` + 2 个记忆工具 + `tool_search`，合计 13 个。未配置 memory 时为 11 个；帮手及后台续接 Session 的组合不同。[R2][R3][R4]

`residentNames` 实际列出 15 个名称，并把所有 `memory_*` 归为常驻；这份候选名单不是每次实际请求的工具数。实验应捕获真实首次请求，不能用静态名单或模型自述计数。[R2]

按需路径已经存在：OpenAI 客户端模式只把常驻 schema 放进初始 `tools`，发现后通过历史中的 `tool_search_output` 返回定义；Anthropic 每次传输完整 deferred 目录并设置 `defer_loading`，通过引用加载。因此请求字节数与模型实际加载、计费 token 必须分别观察。[R5][R6]

当前客户端 `tool_search` 使用工具英文名称/描述的子串及空白分词匹配，不是语义搜索。中文任务能否让模型生成可匹配的 query 是待测项。系统提示已点名 `delegate_work`、`complete_work`；保留提示词的实验测的是完整 schema 是否需要常驻，不能声称工具名称完全未知。[R2][R7]

本轮实际运行 `node --import tsx --test test/native-tool-search.test.ts test/native-tool-search-failures.test.ts`，22/22 通过，退出码 0。测试通过真实 Pi loop、Host、临时本地 HTTP 和纯工具效果覆盖发现、派发、权限拒绝、重启、压缩、定义变化、重复响应与预算。模型输出由夹具预定，所以它们证明协议能工作，不能证明模型自主发现及完成任务的质量。[R8][R9]

## 初稿建议的对照实验（历史方案）

先只改变初始暴露方式，工具实现、全部可用能力、提示词、搜索算法、授权路径及预算保持一致。以下集合是待检验的候选，不是结论：

| 组别 | 初始常驻工具 | 其余能力 |
| --- | --- | --- |
| A | 当前实际约 13 个 | 维持当前 deferred 集合 |
| B | `read`、`bash`、`task_control`、`complete_work`、`tool_search` | 全部保留，按需发现 |
| C | `read`、`bash`、`tool_search` | 同 B，工作控制与结算也按需发现 |

首轮 pilot 选读取文件、受限写入的权限确认、委派后整体结算三个场景，每组各一次，共 9 次任务。先确认采集与验收能工作，并测量真实费用，再决定完整试验预算。本轮只设计方案，不进行付费实跑，也不改变生产常驻集合。

完整首轮用 10 个合成场景 × 3 组 × 2 次独立重复，共 60 次任务：普通聊天、文件读取、创建与编辑、历史检索与原文读取、网页研究、明确时间的计划、委派及接回、中途授权、调整或取消、整体结算。场景及成功条件运行前写定，任务用自然中文表达，不在用户输入中提示工具名。授权不足场景的正确结果可以是明确待确认，而不是必须执行成功。

每次用新的临时数据目录、同一合成资料及授权脚本，固定一个支持原生发现的模型和端点，成对比较任务，随机轮换组别顺序。新 Session 与恢复 Session 分开报告，缓存 token 单独记录；其他模型另行复验。不得同时改搜索算法、工具命名或提示词，否则无法确定效果来源。

主要指标为验收成功率：核对实际成果、持久计划/工作状态、最新 revision 及来源证据，不能仅依赖回答“完成”。辅助指标为初始 schema 大小、全任务 input/output/cache tokens、实际 HTTP 次数、端到端耗时、搜索次数、首次正确发现率、未发现调用、参数错误。计入全部发现往返、重试与帮手调用，不能只比较首次请求。

独立检查授权和结算：发现不得增权；未授权操作无效果；取消工作不能复活；完成必须关联实际成果并结算帮手。沿用 Host 动作账本、任务结果及文件核验，不改为模型自评。[R3][R7][R10] 若减少工具导致这些保证失效，即使 token 下降也不能接受。

60 次只能用于筛选。报告逐场景成对成功/失败、胜负及实际失误，再针对可重复的退化或收益扩大样本。若 B 与 A 表现相当而 C 反复遗漏结算，支持控制入口常驻；若 deferred 组总成本增加，则需定位发现质量或往返成本。没有结果前，不以工具数最少为胜者，也不提出合并或删除能力。

## 来源

外部资料由本轮主研究读取；以上逐项区分公开事实、设计推论和待测假设。产品入口未公布完整初始 schema/count，不能用产品宣传页补造数量。

- [S1] Meta，Muse 产品设计：[Introducing Muse](https://introducing.muse.ai/)。
- [S2] Meta，安全架构：[Security and safety for AI agents: our approach with Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse#least-privilege)。
- [S3] OpenAI，Dots 官方说明：[Dots](https://developers.openai.com/codex/dots)。
- [S4] xAI，产品发布：[Introducing Grok Bot](https://x.ai/news/introducing-grok-bot)。
- [S5] Manus，2.0/Cascade/Cue 发布：[Introducing Manus 2.0](https://manus.im/zh-cn/blog/introducing-manus-2-0)。
- [S6] Manus，2025 年工程经验：[Context Engineering for AI Agents](https://manus.im/zh-cn/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)。
- [S7] xAI，2026-09-11 官方指南：[Grok Bot 101](https://x.ai/bot/guides/grok-bot-101)，Anatomy of a bot、Using Grok Bot、Permissions and a shared computer、Writing code。
- [S8] Cue，官方主页及 FAQ：[Cue](https://cue.im/)。
- [S9] OpenAI，官方 API 指南：[Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)，How it works、Client-executed tool search。
- [R1] [ADR-0008，工具、恢复与预算](../adr/0008-personal-agent-orchestration-direction.md)，第 35 行。
- [R2] [src/personal/pi.ts](../../src/personal/pi.ts)，第 42–43 行常驻分类，第 106–115 行分流，第 281–292 行主对话组装，第 319–322 行后台续接。
- [R3] [src/personal/permissions.ts](../../src/personal/permissions.ts)，第 51 行起的工作工具与授权检查。
- [R4] [src/memory/tools.ts](../../src/memory/tools.ts)，第 7、27 行的两个记忆工具。
- [R5] [src/agent/native-openai-responses.ts](../../src/agent/native-openai-responses.ts)，第 27–43 行发现记录与客户端/服务端目录。
- [R6] [src/agent/native-anthropic.ts](../../src/agent/native-anthropic.ts)，第 25–35 行引用、deferred 目录及服务端搜索。
- [R7] [src/agent/native-tool-search.ts](../../src/agent/native-tool-search.ts)，第 95–104 行匹配，第 108–122 行派发及授权。
- [R8] [test/native-tool-search.test.ts](../../test/native-tool-search.test.ts)，第 106、131、175 行客户端发现及权限测试。
- [R9] [test/native-tool-search-failures.test.ts](../../test/native-tool-search-failures.test.ts)，第 28 行夹具，第 42 行起的失败、重复、预算、恢复及压缩测试。
- [R10] [src/personal/pi.ts](../../src/personal/pi.ts)，第 206 行起的完成验收；[test/personal-orchestration.test.ts](../../test/personal-orchestration.test.ts)，第 105、159、243、255 行帮手结果、修订及取消测试。
