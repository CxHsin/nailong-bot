# 个人 Agent 产品设计调研（2026-09-27）

范围：仅整理官方文档与产品发布内容。这里的“设计启发”是归纳，不等于产品实际保证。Lindy、Manus 的部分材料是厂商自述；未做实测。

## 对照

| 产品 | 入口与任务体验 | 记忆与主动性 | 工具与控制 | 值得借鉴 |
| --- | --- | --- | --- | --- |
| OpenClaw | Telegram bot 支持私聊、群组；默认 long polling；私聊默认配对。消息可在原位编辑以显示流式进度。[Telegram](https://docs.openclaw.ai/channels/telegram)、[Telegram 消息](https://docs.openclaw.ai/channels/telegram/messaging) | `USER.md` 放稳定偏好，`MEMORY.md` 放持久事实，日记文件放近期上下文；定时器持久化任务并可投递到聊天渠道；后台任务有独立状态账本。[记忆](https://docs.openclaw.ai/concepts/memory)、[自动化](https://docs.openclaw.ai/automation/cron-jobs)、[后台任务](https://docs.openclaw.ai/automation/tasks) | 主机命令有 `deny`、白名单、询问等模式；官方明确审批不是用户身份边界或文件系统只读策略。[执行审批](https://docs.openclaw.ai/tools/exec-approvals) | 将聊天会话、触发器和后台任务记录分开；把记忆做成用户可读可编辑的文件。 |
| Letta | 开发者可用 API 构建有状态 agent；它本身不是现成 Telegram 个人助理。[有状态 Agent](https://docs.letta.com/v1-sdk/concepts/stateful-agents/) | 核心 memory blocks 始终进入上下文，可由 agent 更新；archival memory 按需语义检索。[记忆块](https://docs.letta.com/v1-sdk/memory/memory-blocks/)、[归档记忆](https://docs.letta.com/v1-sdk/memory/archival-memory/) | 可以对指定工具设置人工审批；调用时暂停，审批请求包含工具名、参数和上下文，拒绝理由反馈给 agent 继续调整。[HITL 工具](https://docs.letta.com/v1-sdk/tools/human-in-the-loop/) | 分层记忆：少量稳定状态始终可见，大量历史按需检索；审批发生在工具调用边界。 |
| Lindy | 个人 DM 与共享 Slack 线程是不同场景；首次 @mention 后有账号绑定按钮，原消息在绑定后自动重放；共享线程内续聊不用反复 @mention。[设置](https://docs.lindy.ai/teammate/setup) | 官方“Routines”页面描述触发器、自然语言任务和投递目的地三元组，可按日程或事件触发，提供模板和缺失连接的提示。该页 URL 位于 `coming-soon`，上线范围应以实际账号为准。[Routines](https://docs.lindy.ai/coming-soon/routines) | 共享 Slack 线程的连接可设“始终允许／审批／禁写”，审批卡有 Approve/Deny。文档明确这些 guardrail **不适用于**网页聊天、Slack DM、iMessage、SMS；只读操作无需审批。[连接与 guardrail](https://docs.lindy.ai/integrations/overview) | 首次接入不丢原消息；私人与共享场景区别授权；主动任务显示触发条件和投递地。 |
| Manus | 2026-02 产品发布称 Telegram 是首个聊天入口，语音、图片和文件可发给 agent，复杂任务与结果在聊天内交付；发布材料称其只能读取用户直接发给 bot 的私聊消息。[Telegram 发布](https://manus.im/blog/manus-agents-telegram) | Scheduled Tasks 支持一次性及循环任务；可查看、暂停、编辑、删除计划并看执行历史。文档建议先手动运行，再设为计划。[定时任务](https://manus.im/docs/features/scheduled-tasks) | 桌面“My Computer”文档称访问指定文件夹、每条本地命令需显式批准；本地浏览器扩展先授权会话，用户可看独立标签页并关闭中止。[桌面](https://manus.im/docs/features/desktop)、[浏览器](https://manus.im/docs/integrations/manus-browser-operator) | Telegram 入口应直接承接完整任务与多模态输入；长期任务要可管理；本地操作应可见、可中止。 |
| ChatGPT Work / Scheduled | 同一产品区分快速 Chat 与可交付多步工作的 Work；云端浏览器任务可离开聊天继续，遇到登录、补充信息或确认会暂停。[Work](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)、[云端浏览器](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt) | Scheduled 支持一次性、循环和监控任务，集中查看、编辑、暂停及历史结果；部分账号可用 Gmail、Slack、GitHub 事件触发。[Scheduled](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt) | 连接应用把“允许读取／低风险动作／始终询问”等权限分开；需审批的定时任务会暂停。云端浏览器对难撤销或产生承诺的动作请求确认。[应用](https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt)、[云端浏览器](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt) | 用户只说目标，系统判断需不需要开任务；后台运行遇到用户动作时有明确暂停和接管路径。 |
| Claude Cowork | 聊天与任务共用入口的新版体验正在逐步推出；任务可跨设备续做，用户可看到进度并中途指导。[入门](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) | 项目各自有文件、说明、计划任务、记忆；记忆限定在项目内。[项目](https://support.claude.com/en/articles/14116274-organize-your-tasks-with-projects-in-claude-cowork) 定时任务有计划页、历史、暂停、手动运行。[定时任务](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork) | 不同审批模式控制写入；永久删除仍需显式允许。官方强调隔离运行环境不能代替对可读取数据和可执行动作的限制。[安全](https://support.claude.com/en/articles/13364135-use-claude-cowork-safely) | 以项目为记忆和权限边界；任务可自主推进，但敏感动作在人能看懂的节点停下。 |
| Meta Muse | 在 Muse app 或 WhatsApp 中像发消息一样交代多件事；主聊天之外有按主题分隔的 side chats、活动记录、目标页和交付物。[设计文章](https://introducing.muse.ai/) | 长期目标拆成计划并在后台推进；主动建议分为 Ideas 区和真正值得打断用户的消息，可调低或关闭主动程度。[设计文章](https://introducing.muse.ai/) | 每人独立的云端 VM 与浏览器；独立的 Sentinel 负责连接器动作及网络出口审批，凭据对主 agent 不可见，审批是绑定用途和范围的能力授予。[安全设计](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse) | 在任务之上增加目标层；区分“可浏览的想法”和“值得推送的提醒”；把权限裁决放在 agent 无法自行修改的边界。 |

## 具体设计观察

1. **任务状态不应藏在聊天记录里。** OpenClaw 的后台任务有 `queued → running → terminal` 生命周期，终态包括成功、失败、超时、取消与失联；自动化执行和后台任务是两套概念。[后台任务](https://docs.openclaw.ai/automation/tasks) Manus 让用户查看执行历史、错误并暂停计划。[定时任务](https://manus.im/docs/features/scheduled-tasks) Telegram bot 可借此设计任务卡：目标、当前状态、下次动作、交付物和最近运行结果。
2. **主动能力先有触发与投递定义。** Lindy 把 routine 明确分为触发器、提示、目的地，支持定时和事件触发，且模板标识“Ready／Needs setup／Needs admin”。[Routines](https://docs.lindy.ai/coming-soon/routines) Manus 将计划任务与“现在执行”分开，建议先手动验证。[定时任务](https://manus.im/docs/features/scheduled-tasks) 第一版应先支持有名称、可暂停、可检查历史的承诺/提醒，而非依赖模型临时“记得提醒”。
3. **记忆要分“常驻、可检索、短期”。** Letta 的核心块常驻上下文而归档记忆按需检索；OpenClaw 的 `USER.md`／`MEMORY.md`／每日笔记是类似的不同层级。[Letta 记忆块](https://docs.letta.com/v1-sdk/memory/memory-blocks/)、[Letta 归档](https://docs.letta.com/v1-sdk/memory/archival-memory/)、[OpenClaw 记忆](https://docs.openclaw.ai/concepts/memory) 这比无限续接聊天更可解释，也便于用户修正错误偏好。
4. **授权应细到动作与场景。** Letta 在工具执行前暂停并展示参数。[HITL](https://docs.letta.com/v1-sdk/tools/human-in-the-loop/) OpenClaw 明确命令审批的保护边界有限。[执行审批](https://docs.openclaw.ai/tools/exec-approvals) Lindy 的详细文档显示共享线程和私聊的实际规则不同，即使首页宣称“写操作总要审批”，也不能据此推断所有入口一致。[Lindy 首页](https://docs.lindy.ai/)、[详细规则](https://docs.lindy.ai/integrations/overview) 自建产品应在自己的执行层统一实施权限，而不是只在某一渠道 UI 提示。
5. **入口细节会决定能否形成习惯。** Lindy 首次绑定后重放原消息，避免 onboarding 造成任务丢失。[设置](https://docs.lindy.ai/teammate/setup) OpenClaw 支持 Telegram 消息原位进度预览、回复线程和配对。[Telegram](https://docs.openclaw.ai/channels/telegram)、[消息行为](https://docs.openclaw.ai/channels/telegram/messaging) Manus 强调从 Telegram 直接发语音、图片、文档并收取最终文件，这是厂商发布声明，尚未实测。[Telegram 发布](https://manus.im/blog/manus-agents-telegram)

## 对 Pi + Telegram 方案的取舍建议

- 优先做 **Telegram 私聊的一件事闭环**：输入、任务卡、执行记录、结果；对每件事保留一个持久 ID。以上是基于各产品任务管理设计的推论，不是这些产品的共同实现。
- 记忆先实现两个可编辑层级：稳定偏好／项目当前事实，以及可搜索历史；每条长期记忆记录来源和更新时间。依据是 [OpenClaw](https://docs.openclaw.ai/concepts/memory) 和 [Letta](https://docs.letta.com/v1-sdk/memory/memory-blocks/) 的分层设计。
- 主动性先做可管理的提醒和定时任务：创建时明确下一次运行时间、时区、投递地；显示最近一次成功或错误；可暂停。参考 [Manus 定时任务](https://manus.im/docs/features/scheduled-tasks) 与 [Lindy Routines](https://docs.lindy.ai/coming-soon/routines)。
- 所有文件改动、消息发送、外部写入都走独立动作网关：展示目标、参数与影响，用户批准后执行并留下收据。Letta 的工具级 checkpoint 与 Manus 的本地命令批准提供了可核实的设计参照。[Letta HITL](https://docs.letta.com/v1-sdk/tools/human-in-the-loop/)、[Manus 桌面](https://manus.im/docs/features/desktop)
- 后续再加群组、多渠道与自动发现需求。群组会带来身份、上下文泄露和授权差异，Lindy 的共享线程规则可见其复杂度。[Lindy 设置](https://docs.lindy.ai/teammate/setup)、[连接规则](https://docs.lindy.ai/integrations/overview)

## Pi 的实际承载能力与边界

- Pi 的 TypeScript SDK 可在 Node.js/Bun 进程中创建 agent session，支持事件订阅、会话持久化、工具和资源覆盖；会话接受 prompt、steer、follow-up 和 abort。[SDK](https://pi.dev/docs/latest/sdk)
- 长期任务状态仍应由应用自己的数据库管理：Pi 会话是推理与工具调用上下文，不是提醒、审批、重试和外部副作用的唯一账本。这是架构推论，依据为 [Pi SDK 会话生命周期](https://pi.dev/docs/latest/sdk) 与 [OpenClaw 后台任务记录](https://docs.openclaw.ai/automation/tasks)。
- Pi 默认没有内置沙箱。内置工具和扩展继承进程权限；无人值守或不可信输入场景要限制进程可访问的文件、凭据和工具，必要时放入容器或独立系统账号。[Pi 安全](https://pi.dev/docs/latest/security)

## 建议的第一版

产品定位：一个在 Telegram 中接单、能跨天交付、行动可核查的个人 agent。Telegram 是入口和控制台；任务、触发器、记忆、审批由本应用管理；Pi 负责每次运行中的推理与工具调用。

1. 用户给 bot 发目标。简单提问直接回答；需多步处理、未来跟进或外部动作时创建任务卡。卡片显示目标、状态、下一步、最近运行、交付物，可在原消息更新，参考 [OpenClaw Telegram 消息](https://docs.openclaw.ai/channels/telegram/messaging) 与 [ChatGPT Work](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)。
2. 任务有持久 ID 和明确状态：`queued → running → waiting_for_user / scheduled → completed / failed / cancelled`。每次运行单独记录开始时间、结果、错误、外部动作。定时触发仅启动一次运行，不暗中替代任务状态；参考 [OpenClaw 后台任务](https://docs.openclaw.ai/automation/tasks) 与 [Manus 定时任务](https://manus.im/docs/features/scheduled-tasks)。
3. 记忆分为用户可编辑的稳定偏好、项目事实和按需搜索的历史片段，记录来源及更新时间。任务卡引用实际用到的记忆，参考 [Letta](https://docs.letta.com/v1-sdk/memory/memory-blocks/) 与 [Claude Cowork 项目](https://support.claude.com/en/articles/14116274-organize-your-tasks-with-projects-in-claude-cowork)。
4. 工具先分读取与写入。写文件、发外部消息、执行本地命令统一经过应用层动作网关，给用户展示具体对象、参数和影响；批准后执行并留下行动收据。审批发生在工具调用前，而不是由模型自行口头判断；参考 [Letta HITL](https://docs.letta.com/v1-sdk/tools/human-in-the-loop/) 与 [Pi 安全](https://pi.dev/docs/latest/security)。
5. 主动能力先支持一次性提醒和定时任务，创建后能看下一次执行、运行历史、暂停与取消。事件触发和自动扫描项目在观察到稳定使用后增加；参考 [ChatGPT Scheduled](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt) 与 [Claude Cowork 定时任务](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)。

第一阶段只做 Telegram 私聊、文本输入、任务卡、一次性提醒、项目级记忆和受限的只读／文件写入工具。用三个真实任务验收：跨天跟进一项研究；读取一个本地项目并提出下一步；审批后修改一个指定目录的文件，并能看到收据。语音、图片、群组、多个外部应用和自主巡检作为后续迭代。

## Meta Muse 带来的修订（2026-09-27）

Muse 公开的设计文章给出一个比“聊天 + 任务列表”更完整的结构：**目标 → 计划 → 多个任务 → 每次运行 → 实际行动**。它的 Goals 页负责长期追踪，活动页回答“agent 正在干什么”，Ideas 页承接非紧急建议；只有真正有新进展或需要用户判断的情况才主动发消息。[Muse 设计](https://introducing.muse.ai/) 这是对前述“未完事项雷达”的重要修订：主动发现可以先进入想法收件箱，推送应有更高门槛。

Muse 的权限设计也更明确。主 agent 在运行容器里，凭据存在另一个服务，独立 Sentinel 对连接器动作和网络出口做最终裁决；审批由客户端直接交给 Sentinel，并绑定目标、用途、时间等范围，而不是一句聊天回复。[Muse 安全架构](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse) 这是一套高投入云端架构，不能直接等同于本地 Pi 扩展。Pi + Telegram 的可实现版本应先让 Pi 看不到真实外部服务凭据，只能调用应用提供的类型化工具；写入工具的批准令牌由 bot／执行器验证，并且执行器与 Pi 进程分开。若允许任意 shell 或浏览器联网，就需要更强的进程和网络隔离。[Pi 安全](https://pi.dev/docs/latest/security)

对第一版的改动：给任务增加可选的 `goal_id`，允许一个长期目标下挂多个任务；增加只读的 `/goals` 和 `/activity`；让主动发现先落入“建议箱”，每日摘要或明确有截止风险时才推送。目标页和建议箱可以先用 Telegram 命令与消息实现，无需做完整客户端。Muse 的完整 VM、自动造工具、跨服务购买和多 agent 协作不应成为首版依赖。上述 Muse 能力依据 Meta 官方发布与设计说明，未做独立产品实测。[发布](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)、[设计](https://introducing.muse.ai/)
