# Personal Agent 操作与验收

更新：2026-10-13，当前规格 [#167](https://github.com/CxHsin/nailong-bot/issues/167)，入口见 [README](../README.md)，当前证据见[本轮验收](personal-agent-acceptance-20261013.md)。2026-10-12 #157 的 `d03422048b6a22502e8ac1952ae3d3a434612bc1` 是历史重构基线。

## 配置

模型仍使用 `MODEL_NAMES`、`MODEL_DEFAULT`、`MODEL_<别名>_*`。`AGENT_CAPABILITIES_FILE` 指定 skillSources/mcpServers/executionTool JSON；路径和提示词在连接外部服务前验证。embedding、MEMORY_DYNAMICS、MEMORY_RECALL 作用于独立记忆检索与学习。

| 变量 | 默认/用途 |
| --- | --- |
| `AGENT_MAX_CONCURRENT` | 2，独立任务并发 |
| `AGENT_TASK_TIMEOUT_MS` | 1800000，执行时间预算 |
| `AGENT_MODEL_TIMEOUT_MS` | 120000，单次模型交互 |
| `AGENT_MAX_TURNS` | 40，工具轮次上限 |
| `AGENT_MAX_TOKENS` | 500000，执行用量预算 |
| `AGENT_MAX_ATTEMPTS` | 3，任务尝试上限 |
| `AGENT_MAX_DIALOGUE_ATTEMPTS` | 3，输入处理尝试上限 |
| `AGENT_ROOT_MAX_CALLS` | 100，同一整体目标及帮手的模型/外部执行调用上限 |
| `AGENT_DAILY_MAX_CALLS` | 500，UTC 日全局调用上限 |
| `AGENT_DAILY_MAX_TOKENS` | 2000000，UTC 日全局实际可得 token 预算 |
| `AGENT_MAX_REWORK` | 3，关联返工及同目标重复委派上限 |
| `AGENT_MODEL_MAX_RETRIES` | 2，SDK 模型重试上限；可设为 0 |
| `AGENT_SHELL_PATH` | 可选 Pi shell |
| `AGENT_VERIFICATION_CHECKS` | JSON 数组，确切 command/args/cwd，部署者预先授权 |
| `AGENT_CHECK_TIMEOUT_MS` | 120000，检查命令上限 |
| `AGENT_CODEX_SANDBOX_EXECUTABLE` | 可选，候选的物理执行文件；不会自动安装或配置 |
| `AGENT_CODEX_SANDBOX_EVIDENCE` | 可选，version1 unelevated采样记录；当前候选只能诊断并拒绝受限命令 |

本地执行与验收模型用量合并进入 Attempt 预算；herdr 外部执行用量未知，不能推定免费。验收受模型超时与 Task 取消信号约束。未知动作消费不能当作可安全重试。计划停机期间不运行，恢复按持久错过策略处理。

## Telegram 回复渲染与预览（#174）

私聊正式文字使用 `sendRichMessage` 的 Rich Markdown，支持标题、列表、代码块和表格。Channel 将完整 Markdown 块组合为不超过 8000 UTF-8 字节、保守块数预算的页面；超大单块按 Unicode 字符分页为原文文本，不保证超大表格仍保持表格布局。无法解析的格式仅在 Telegram 明确返回格式拒绝时降级为纯文字富消息块；网络超时、未知发送和限速不触发另一种格式的重复发送。回复中的远程图片及 HTML 媒体语法显示为文字，不因渲染而上传附件；验收文件仍走独立文件交付。

Pi 当前用户对话的 assistant 正文快照经 Host 进入 Telegram Channel，思考、工具参数、后台续接和计划输入不进入预览。草稿使用 `sendRichMessageDraft`，同一回复使用同一个非零 draft_id，默认每秒最多一次更新并合并增量；429 按 retry_after 等待。长回复预览最新页面。未闭合或不合法的格式遇明确解析拒绝时预览原文文本；其他草稿错误停止该回复的预览，不阻断正式交付。

草稿仅为 30 秒临时预览，生成结束或失败即停止更新；正式消息及文件发送前等待在途草稿请求，并暂停新的草稿派发。关闭 Channel 会清除定时器并等待在途预览。没有启用 Telegram 停止生成按钮；任务停止继续使用已有工作控制入口。草稿不持久化，不产生消息回复关联，不触发记忆学习，重启不恢复草稿。正式分页成功后才记录各页消息 ID；既有 unknown 不重发规则继续适用。

受控验收覆盖 Pi SSE → Host → grammY 在模型结束前出现草稿、最终表格正文、正式发送后学习，以及合并增量、限速、草稿/正式消息竞态、格式降级和网络未知不重复。真实 Telegram 客户端的显示、版本兼容性及实际限速尚未验收；本轮未部署生产 bot。研究依据见 [接口调研](research/telegram-markdown-streaming-2026-10-13.md)。

2026-10-13 验证：`npm test` 218/218 通过（新增 `test/telegram-rich-reply.test.ts` 11 个用例）；`npm run typecheck`、`npm run build`、`npm run docs:check` 均通过。临时移除 Pi 正文回调接线后，`actual Pi SSE → Host → grammY previews before generation finishes and learns only formal delivery` 用例按预期以 `No preview before model finished` 失败；恢复实现后完整回归通过。

## 切换与回退

1. 停止旧 writer，对完整数据目录做外部备份，不同时运行新旧入口。
2. 先在副本启动 CLI。迁移只读旧源，备份源/归档/checkpoint/记忆后校验并提交一次 Session 导入清单。
3. 核对源摘要、会话身份与排除来源；坏活动边界/缺失归档拒绝迁移。不要删除标记绕过错误，旧委托不变成新 Task。
4. 上线前完成真实 Telegram 验收。正常退出保留任务，重启先核对执行者，不重复未知效果。
5. 回退前停止新进程并保存完整当前目录。旧代码不理解 personal.sqlite 的新增任务/授权/交付；使用切换前副本运行旧版，保留新目录及执行身份并人工核对未完成义务。仅 git 回退不能恢复业务状态。

本次实现不自动部署、启动生产 bot 或合并。

### 业务 schema 升级（#168）

2026-10-13 新增独立 `personal_schema`；#168 引入版本 1，#171 升为版本 2，新增持久全局/整体目标预算；#172 升为版本 3，保存工作约定及修订。打开已有 `personal.sqlite` 时，Host 先取得数据目录所有权，再用 SQLite `VACUUM INTO` 将包含已提交 WAL 页的一致快照写入 `personal-schema-backups/`，同步备份文件并检查完整性后才提交升级。备份失败会关闭数据库并释放所有权；高于当前代码支持的版本拒绝启动。已成功升级的目录重启不再备份或重复迁移。

旧 Task 增加整体工作身份及自身 root 身份；原 Task、Attempt、Plan、Session、Delivery、原文和排除记录保留。旧 Attempt 的实际要求版本与旧成果产生版本无法从当前 Task 修订号推知，因此保持未知。历史 Session 导入清单不参与业务升级，也不会重新导入。#172 独立 personal-memory.sqlite schema v1 使用相同一致快照机制保存召回、实际呈现及学习事实；业务备份不替代记忆备份。旧完成成果不创建新的交付；待交付及 unknown 记录保持。

存储接口提供委派结果与唯一工作事件的原子结算、Session 注入/完成回执和动作派发账本。结果事件消费记录表示本体处理了材料，不能证明整体目标符合最新要求。子结果不会创建 Delivery。重启时已存在的动作身份须核实；unknown 不是重新派发许可。#171 在生产工厂接入下面的闭环；此处说明代码行为，不表示生产 bot 已部署。

自动 schema 备份只覆盖此次修改的业务数据库；完整部署回退仍需上述完整数据目录外部备份，包括 Session 和记忆原件。

### 本体与帮手续接（#171）

主 Session 的 `delegate_work` 创建研究或整理帮手。编码读取项目 herdr-workflow skill，通过现有 Shell 调用 CLI；配置与权限见[能力说明](capabilities.md)，真实验收见[记录](personal-herdr-skill-acceptance-20261013.md)。旧固定执行器已退役；历史 herdr Task 保留身份，未知状态不重派、不改派本地，不推断完成或停止。其他帮手的恢复和资源保证保留。

结果先结算进唯一事件，再通过原生 `nailong_work_result` 自定义 Session 消息回本体。它保持执行材料身份，不进入 Host 用户输入、检索触发或学习轮次。已排队的真实用户消息先处理；同一主 Session 串行打开。整体补充要求创建持久 `requirements_changed` 事件，本体通过相关帮手控制工具选择目标，不广播全部孩子。整体完成由 `complete_work` 显式提出，Host 在实际材料检查后重读要求版本及取消/活跃孩子；旧版本只保留材料。轻量本体文件工作也通过该工具及实际用户 Session 条目/完成标记结算。

研究使用 `submit_material` 提交本地原文路径或受控远端 receiptId、匹配的摘录、支持结论及不确定性；本地文件按 local 标记，不冒充远端来源。远端来源需成功受控检索回执，包含 URL 与真实 provider-returned payload 摘要，孩子及本体从同 root 账本核验；没有回执的 URL 或生成文件不构成远端证据。无效已声明材料保持 partial，不能被其他有效文件掩盖。整理通过受控文件移动/删除的前后路径、SHA256 与数量凭据检查实际变化；目录创建或任意 manifest 不能单独通过。编码验收保留实际检查与文件摘要、原始子任务修订号和父要求版本，文件在检查后改变或旧父要求不匹配时保持 partial。整体通过后冻结交付文件，本体最终交付才关联原始用户输入；计划触发不伪造用户学习轮次。

父停止先持久标记后代再终止；只停帮手仅影响该分支。终止未知显示正在停止并占资源，不声称撤销已有影响。恢复先核对 Session 真实条目、完成标记、事件和派发账本。已确认工具结果可复用；同一工作有 unknown/dispatching 动作时，新 callId 或新委派也不能绕过暂停。Session 完成标记已 fsync、Host 事务未提交的轻量完成可直接修复，不再调用模型。此机制不承诺模型和工具 exactly once。

全局/整体调用及 token 预算跨重启持久；普通对话在工作尚未建立前归全局预算。每个可观测模型 HTTP 尝试（含重试及 provider 续接）在派发前预留调用，SDK 实际可得用量和成本字段记账；herdr 内部调用、token 或成本不可见时保留 unknown，只计 Host 启动及已观察用量，不假定免费。达限保存材料、暂停并生成一次预算通知，不自动扩额。独立命令后端及真实进程终止仍需部署验证；直接 herdr CLI 不纳入 Host 外部任务账本；测试注入后端只证明公共契约。

## 召回、约定与权限诊断

同一真实用户输入以 conversation/actor/input 唯一身份保存一次召回。started 的未知嵌入不重新请求；不可用事实保留并允许文字检索回退。工具续步、计划和后台材料不会自动召回，孩子没有全部历史搜索工具；request_context 定向请求由本体 provide_context 选择原文。嵌入 HTTP 在实际派发前记全局预算，成本不可见保留 unknown；后台瞬时失败最多3次。已送达学习保留原用户时间/身份，后台报告不伪造新用户轮次。

working_agreements 按需原生发现，支持工作/项目/明确全局的内容、修订和撤销。保存前展示内容和范围，用户后续“确认动作 ID”或“拒绝动作 ID”处理，模型 approved 参数不能伪造用户确认；约定不扩大权限。计划专用操作同样通过原生发现 plan_control，不放进常驻 task_control schema。

后端诊断通过 runtime.backendDiagnostics 返回候选身份和失败原因，配置/evidence 不来自模型。当前 unelevated 只有部分写边界，未实现完整受限 execute；默认受限命令继续受阻。Shell 与结构化独立检查分别核对当前范围、模式、版本与身份；supports 等待期间缩小授权会阻止派发，外部 Agent 目标变化需重新核验原授权。可信 Shell 仍继承本机权限。具体证据格式见 execution-backends.ts 的 CodexProbeEvidence，版本不支持/过期/文件 hash 或 OS release 变化不沿用证据。

unknown/dispatching 保持工作占用，新 callId 和新委派不能重复未知效果。人工先核对既有结果、实际执行身份及 Delivery；确认没有效果之后仍需通过明确恢复决策继续，不能删除账本或篡改回执把 unknown 改成成功。没有完全验证的终止结果不能释放资源。默认新目标不继承旧可信权限。

## 验证证据

| 保证 | 实际覆盖入口 |
| --- | --- |
| 并行/冲突、授权、持久输入、停止/恢复 | personal-host 测试，Host 输入+受控 executor |
| 原生 Session、文件、compaction、切换及遗忘 | personal-session，真实 Pi+本地 Provider |
| 生产工厂、独立成果读取与交付 | personal-runtime，Channel→runtime→Pi |
| Telegram 鉴权/对话/文件及未知分页 | personal-channel，grammy+受控 API |
| 计划修改、期限、错过及原子触发 | personal-plans，Host 输入+受控时钟 |
| 命令退出码/超时/进程树停止 | personal-verification，真实本机进程 |
| 只读导入、排除、坏边界/reset/restart | personal-migration |
| 所有权、崩溃、收件箱和未知恢复 | host-process，实际生产 CLI 子进程 |
| 固定入口退役、历史任务不重派 | personal-host，personal-runtime |
| 本体/帮手结果闭环、类型验收、选择性改向、预算及崩溃窗口 | personal-orchestration，生产 Pi HTTP 和实际成果检查 |

2026-10-12 #157 历史 Windows/herdr/Codex 已验证：实际文件42/64；计数进程停止于33，父子 PID 消失；崩溃窗口后同 Task 验收128且无新 prompt。临时具名会话已清理，默认会话未操作。详见[实机记录](personal-herdr-acceptance-20261012.md)。它不证明真实 Telegram 闭环。

2026-10-12 已获授权完成真实 Telegram 文字入站、真实模型回复、消息与文件出站，并根据实机失败修复默认任务目录及验收凭据。修复后同一授权目标通过结构化 Host 重试完成独立文件验收，附件消息470已发送；该重试不能算修复后的新自然语言入站。详见[Telegram 实机记录](personal-telegram-acceptance-20261012.md)。

仍待真实 Telegram 完整矩阵：修复后的自然语言接单、图片、运行中对话/改向、并行冲突、停止、活动任务重启及计划。基本收发不能替代完整验收。Claude 未启用，任意外部网络动作仍受执行器实际权限边界限制。
