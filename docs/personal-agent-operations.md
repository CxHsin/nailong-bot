# 持久队列主助手操作说明

当前队列与执行规格 [#201](https://github.com/CxHsin/nailong-bot/issues/201)，架构 [ADR-0011](adr/0011-durable-main-agent-and-conversation-queue.md)，验证状态见 [切换验收](durable-assistant-acceptance-20261015.md)。上下文与记忆遵循 [#208](https://github.com/CxHsin/nailong-bot/issues/208) 和 [ADR-0012](adr/0012-layered-memory-and-stable-context.md)，见[上下文验收](context-management-acceptance-20261016.md)。nailong 负责输入接收与会话调度，Pi Durable 1.2.0 保存主 agent 执行进度。

## Telegram 如何接入

沿用现有 BotFather token。填写 `.env` 的 `AGENT_TELEGRAM_BOT_TOKEN` 和 `AGENT_TELEGRAM_USER_ID`（也接受 `TELEGRAM_*`），配置主模型后运行 `npm start`。服务通过 grammY long polling 接收该主人的私聊，文字和图片进入同一个主会话。当前不支持群聊或多 bot。CLI 使用 `npm run chat` 或 `npm run send -- "内容"`，可加 `--conversation-id telegram:private:<owner id>` 指定会话。

只启动一个实例。若之前配置 webhook，须自行确认 polling 的使用方式；新版启动不会自动删除 webhook。先停止旧入口，再运行新版，避免两个进程消费同一 bot 的更新。旧 token 不必重新申请，旧数据也不会自动清除。

支持 Markdown 富消息、代码与表格、长文分页、临时正文草稿预览和 `send_file` 文件交付。只有明确的格式 400 拒绝才降级原文块；连接断开等未知结果写入 `telegram-sends.jsonl`，不自动重发。草稿是预览，不能证明最终消息已送达。文件发送错误返回模型；结果不明时先核对记录。

## 数据与会话

`ASSISTANT_DATA_DIR` 默认 `data/pi-durable-v1`。显式配置可覆盖，但须使用独立新执行空间；启动检查拒绝把旧 Session 目录当作新空间。不要把它指向 `data/pi-assistant-v1` 或旧 Host 目录。配置、模型端点与凭据接入继续沿用，不导入旧历史、摘要、工具轨迹、Akasha 或 Task，不删除旧目录或成果。

新空间分别保存完整输入与固定批次、主执行记录、会话控制与帮手材料，以及通道发送回执。已有外部 herdr 委派须保留并核对真实身份，不能因新会话没有历史就重新派发。工作目录由 `ASSISTANT_WORK_DIR` 指定，默认启动目录，重开会话沿用原目录；`AGENT_PROMPT_FILE` 默认 `system-prompt.md`，`AGENT_SHELL_PATH` 可指定 shell。工作目录与执行数据空间各自独立。

`ASSISTANT_LEGACY_DATA_DIR` 默认 `data/pi-assistant-v1`，只读查找旧会话中的 helper 身份并登记到新空间，不导入对话历史，也不修改旧目录。旧记录损坏时先修正记录再启动。

新目录中，`queue.sqlite` 保存事件、批次及内部结果，`queue-owner.sqlite` 用于单服务独占，`assistant.sqlite` 保存会话控制、帮手身份和输出交付记录；各会话的 Durable 步骤位于 `executions/<会话标识的 SHA-256>/session.sqlite`，Telegram 发送回执位于 `telegram-sends.jsonl`。备份时停止服务并保留整个数据目录。

同一数据目录的 Telegram 与 CLI 不同时启动。`--full-access` 接受为可信执行声明，`--restricted` 拒绝，因为新版没有受限执行后端。

## 队列与命令

输入确认接收前保存来源身份、会话、正文、图片材料和顺序。重复投递的同一源消息去重；正文相同但身份不同仍是两条输入。每个会话一次执行一个主 agent 处理轮次，其他会话可分别推进。

原输入先持久接收，再由独立模型判断有序动作及实际工作目标。独立直接输入同级 FIFO；补充可关联当前、排队或已登记 helper 的目标，排队补充保留原位置。空闲或当前轮结束时领取已有输入的有限快照，先完成快照内关系判断或有界降级，不等待未来消息。命令、来源及优先级隔开批次；一批可包含多个目标，取消只撤销指定目标，其他项复用成果继续。

| 命令 | 行为 |
| --- | --- |
| `/help` | 显示用法 |
| `/model`、`/model 别名` | 查看或切换主模型；外部 Codex/Claude 模型不随之改变 |
| 自然语言补充 | 识别目标后按原顺序交给对应工作；主执行的普通补充不立即中止工具 |
| 自然语言取消 | 取消排队目标或尽快发起执行/帮手中断，保留成果；停止状态单独核实 |
| `/resume [批次ID]` | 明确继续本会话暂停的工作；省略 ID 时继续本会话全部暂停项 |
| `/reset` | 清主上下文，保留已接收事件、执行进度和帮手身份；不取消工作、不停止外部进程 |

旧 `/steer` 入口已退役，收到后提示直接用自然语言交办，不剥除前缀执行。连续补充保留各自来源身份；当前执行未消费时转为基于已有成果的后续处理。取消标记跨重启、reset 和 resume 保留。直接用户输入高于后台事件，可抢占低优先级轮次；未知外部效果仍先核实。

`ASSISTANT_INTENT_MODEL` 指向 `MODEL_NAMES` 中已配置凭据的别名，独立于 `/model`。未配置时以 `not_configured` 原文兜底；非法别名启动时报错。默认总超时 8000ms、估算输入 8192 token、输出 1024 token、近期 6 个用户轮次及确认助手文字，可用同前缀的 `TIMEOUT_MS`、`INPUT_TOKENS`、`OUTPUT_TOKENS`、`RECENT_TURNS` 环境变量覆盖。正整数及模型窗口校验在启动时完成。判断无工具、非流式且不重试；超时的迟到结果无效。

Cloudflare 通用文本模型可通过现有 `openai-completions` 模型别名接入，base URL 为 `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1`，使用 Workers AI Token 和完整模型名。专用 Clef 入口已按用户要求删除，分类配置恢复为通用模型别名；历史结论见[旧评测](research/clef-joint-routing-evaluation-2026-10-17.md)。通用模型的合成 API 评测入口为 `scripts/acceptance/cloudflare-routing-live.ts`，读取已有 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`，不启动 Bot 或更改运行配置。

分类器对上述官方 Cloudflare 端点的 `@cf/qwen/qwen3-30b-a3b-fp8` 和 `@cf/zai-org/glm-4.7-flash` 请求 JSON Schema 输出，分别约束 request、supplement/cancel、clarify 的字段，并把 Schema 和额外提示计入输入预算。Qwen 在快照之后附加官方软开关 `/no_think`；GLM 发送 `chat_template_kwargs.enable_thinking=false`。这两条分类路径不使用 `reasoning_effort`。Qwen 的硬开关会使本次实测的 Cloudflare 正文为空，故不使用；不从 reasoning 字段提取控制动作。其他模型/端点沿用原协议参数。结构化输出仍需通过原文跨度、可见目标及候选完整性校验；不保证模型选择的目标语义正确，实测局限见[调用修复评测](research/cloudflare-routing-controls-evaluation-2026-10-17.md)。

Telegram 原消息和发送回执关联回复目标；一条回复对应多个目标时保留全部候选。图片无真实说明文字时直接兜底，保留原图；默认图片提示不充当用户意图。歧义、超时、预算不足或无效结果通过独立运行时材料告知主助手，原话及身份保留。

应用接口 `routingStatus(conversationId)` 可查看分类别名、待处理路由及工作身份/进度。`queue.sqlite` 保存原输入、快照来源、决定及动作进度；`assistant.sqlite` 保存补充提交、helper 控制证据和回复关联。未知 helper 发送不自动重发，CLI 接受不表示已采纳；helper 控制按真实身份分别推进，不等待主助手无关工具。

## 编码与恢复

herdr-workflow 负责派发、确认接收、转交要求、停止和独立成果核对；`herdr_watch` 只登记并观察已派发帮手。主 agent 可结束派发轮次并接收后续输入，helper 在独立上下文中执行，不把全部中间操作填进主会话。

回传先作为内部材料持久保存；当前轮结束后先处理已经排队的直接用户输入，再交给主 agent。它不进入普通用户消息队列，也不因回传本身直接发送 Telegram。主 agent 核查实际文件、差异与命令结果，不能把 idle/done 当作成果验收。重启查询原 herdr 身份与状态，不盲目启动替代任务。

意外退出后重开同一新空间，恢复已接收输入、原批次和已提交执行。已确认模型/工具结果复用，不通过重跑整个轮次重试单次请求。模型临时故障仅由执行器重试：最多 3 次，含首次共 4 次请求，基础等待 2 秒；底层 provider 不叠加重试。

重试耗尽后保留进度、暂停并通知一次，等待明确继续，其他输入仍可处理。重启保持主动暂停或待核实状态。工具与业务错误交回模型判断，不机械重试任意 Shell。外部操作结果不明时先核实：确认完成则采用结果，确认未执行才执行，无法确认则暂停询问。停止、抢占、重置都不能撤销已有影响。

cron、邮件、Slack、herdr 内部步骤恢复和服务器部署仍在范围外。`run:diagnose`、`context:diagnose` 和旧 `migrate` 为旧日志离线工具，不能用于恢复新版执行。历史验收只适用于其记录的基准，进程强杀证据不能推导断电持久性或跨系统 exactly-once。

## 上下文与长期记忆

每个压缩代固定实际 system 记忆快照，重启复用原内容。新记忆和纠正通过有身份的追加材料即时交给主模型，压缩或 reset 才归并到新快照。真实项目指令或工具配置改变时重新加载。当前编码顺序为 project、skills、memory、material-routing、恢复提示（需要时）、SDK instructions；工具定义顺序固定，由 provider 编码器处理协议。

`assistant-memory.sqlite` 保存来源、版本、纠正关系、遗忘规则、已完成的检索与快照。`memory/MEMORY.md`、`SELF.md`、`topics/` 是程序维护的可读档案，直接编辑 Markdown 不会导入记忆。MEMORY 保存用户事实及偏好，SELF 保存有用户原话依据的理解和关系，全局及项目 topic 保存经历。项目身份是实际工作目录；自然项目名放在 topic 中。

每条真实用户输入分别准备主题和 Akasha 原文召回，合批共享总预算；工具续步和 reopen 复用已记录结果，包括零命中。当前召回是本地词项/中文双字匹配，跨主题改述可能需要显式 `memory_search`；已知来源用 `memory_read` 分页。旧 Host/Akasha 未导入，工具全文保留在工具归档。

明确要求记住、纠正或忘记时，主助手调用 `memory_write` / `memory_forget` 立即处理。写入须引用真实用户原话并匹配当前版本；纠正使用 supersede，撤回使用 retract。压缩完成后的后台提炼只读取实际覆盖的原始用户记录，经相同治理边界写入，helper 只能提供候选。

默认忘记撤回派生记忆并持久排除相关来源及助手改写，立即清理快照、已保存的召回和追加材料；受影响摘要从存活原文及 Durable 记录定位重建，保留其他任务进度。reset 不遗忘长期记忆；默认忘记保留原始记录，不表示彻底物理删除。

## 工具原件、媒体与预算

长工具结果首次返回即落在 `executions/<会话 SHA-256>/archives/`，模型只接收状态、受限预览和 `archive:` 引用。已知引用直接 `archive_read`；未知引用通过 `archive_search` 按关键词、工具、命令、时间或文件定位。分页同时约束 UTF-8 字节和行数，超长单行使用 nextOffset 继续；搜索也有有限候选和游标。一次读取不自动预取下一页。原件与 Conversation 数据共同保留，无自动过期删除；索引损坏、无匹配和原件缺失会分别报告。

媒体保存在同级 `media/`，manifest 保留来源、类型和顺序。简单图片保持视觉输入；批量或大媒体在送入主模型前转为 manifest 与 helper 指引。高成本独立资料或媒体工作复用 herdr-workflow 和原 helper 身份，回传简洁结论及必要路径，主助手按需核验。浏览任务先确认 helper 能连接对应登录 tab。

可选 `ASSISTANT_CONTEXT_CONFIG_FILE` 指向 JSON 文件，路径相对启动目录。可部分设置 archive、memory、media、compaction，其余使用默认值：

| 配置 | 默认值 | 目的/上限 |
| --- | --- | --- |
| archive.thresholdBytes / previewBytes | 16384 / 4096 | 在 SDK 保留上限前卸载；预览最大 8192 |
| archive.readBytes / maxReadBytes | 8192 / 32768 | 每页字节；硬上限 32768 |
| archive.readLines / maxReadLines | 100 / 500 | 每页行数；硬上限 500 |
| archive.searchLimit / maxSearchLimit / searchBytes | 10 / 50 / 8192 | 候选硬上限 50，响应预算最高 16384 字节 |
| memory.residentBytes / topicBytes / akashaBytes | 6000 / 3000 / 4000 | 分开约束并按来源/事实去重 |
| memory.inputBytes / searchResults / readBytes | 8000 / 8 / 6000 | 每批自动材料总预算、显式搜索数、原文每页 |
| media.batchImages / maxInlineBytes | 3 / 524288 | 达到图片数或超过字节阈值时转 manifest |
| compaction | Pi Durable 1.2.0 默认策略 | 可覆盖 enabled、reserveTokens、keepRecentTokens、backgroundTokens |

预算是保守起点，不是模型最优参数。例如 `{"archive":{"previewBytes":2048},"memory":{"inputBytes":6000}}`。压缩沿用原生容量与后台机制，未增加固定空闲计时；配置较小模型窗口时须为 SDK 的输出安全余量留空间，真实验收采用 16000 窗口、6000 reserve、1200 keepRecent。

各会话 `requests.jsonl` 保存实际 provider 请求字节、模型、时间、延迟及 usage，不保存凭据和请求正文。未提供的 usage/cache 指标为 null；相同前缀不能证明远端缓存命中，配置价格为零也不能证明省钱。
