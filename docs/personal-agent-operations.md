# 持久队列主助手操作说明

当前队列与执行规格 [#201](https://github.com/CxHsin/nailong-bot/issues/201)，架构 [ADR-0011](adr/0011-durable-main-agent-and-conversation-queue.md)，验证状态见 [切换验收](durable-assistant-acceptance-20261015.md)。上下文与记忆遵循 [#208](https://github.com/CxHsin/nailong-bot/issues/208) 和 [ADR-0012](adr/0012-layered-memory-and-stable-context.md)，见[上下文验收](context-management-acceptance-20261016.md)。nailong 负责输入接收与会话调度，Pi Durable 1.2.0 保存主 agent 执行进度。

## Telegram 如何接入

沿用现有 BotFather token。填写 `.env` 的 `AGENT_TELEGRAM_BOT_TOKEN` 和 `AGENT_TELEGRAM_USER_ID`（也接受 `TELEGRAM_*`）及必填 `AGENT_SYSTEM_PROMPT` 后运行 `npm start`，再由 Magpie 连接并明确选择模型。未连接或未选模型也可打开控制入口，普通输入持久等待。服务通过 grammY long polling 接收该主人的私聊，文字、图片和 document 附件进入同一个主会话。当前不支持群聊或多 bot。CLI 使用 `npm run chat` 或 `npm run send -- "内容"`，可加 `--conversation-id telegram:private:<owner id>` 指定会话。

只启动一个实例。若之前配置 webhook，须自行确认 polling 的使用方式；新版启动不会自动删除 webhook。先停止旧入口，再运行新版，避免两个进程消费同一 bot 的更新。旧 token 不必重新申请，旧数据也不会自动清除。

支持 Markdown 富消息、代码与表格、长文分页、临时正文草稿预览和 `send_file` 文件交付。只有明确的格式 400 拒绝才降级原文块；连接断开等未知结果写入 `telegram-sends.jsonl`，不自动重发。草稿是预览，不能证明最终消息已送达。文件发送错误返回模型；结果不明时先核对记录。

## Magpie 连接与模型选择

先启动 Nailong 以创建默认配置目录，再从仓库根目录安装 [Agent 插件](../plugins/nailong-agent/README.md)：

```powershell
magpie plugin add ./plugins/nailong-agent
```

在 Magpie 的 Agent 页面连接 Nailong Bot，然后明确选模型。默认连接配置为用户目录下的 `.config/nailong/magpie.json`，在 Windows 也使用这个位置，不随启动工作目录变化。自定义位置时，在 Nailong 及启动 Magpie 的环境中设置同一个绝对路径 `NAILONG_MAGPIE_CONFIG`，并改为安装 `./plugins/nailong-agent/custom.agent.js`。Magpie 插件运行环境使用原生路径变量展开，自定义入口与默认入口二选一。`.env` 只会影响从该文件启动的 Nailong，不能替 Magpie 设置进程环境。

插件仅维护 JSON 的 `baseUrl`、`apiKey` 和 `model`，保留其他配置。模型字段保存 `magpie/` 加完整目录 ID；例如 `magpie/provider/team/model` 对应实际请求的 `provider/team/model`。该前缀用于 Magpie 菜单回显，不能把目录 ID 本身按斜杠截短。不要手工把逐模型密钥搬到面板中。

Telegram `/start` 打开首页，`/model` 打开模型目录。全部与常用列表共享一次目录快照；打开模型页及明确刷新会更新目录，普通翻页不额外刷新。详情展示目录已提供的能力，缺失项显示未知。刷新失败保留上次列表并提示失败；成功刷新确认下架的模型保持原选择和工作，但需要重新选择。连接关闭时停止新的主请求，不自动回到旧直连配置。

Magpie 的模型字段仅绑定配置 owner 的 Telegram 主 Conversation。该会话在 Telegram 与 Magpie 的最后一次明确修改胜出；目录刷新、回写回声和重启不算新选择。其他 CLI Conversation 自己保存选择，可以用 `/model 完整模型ID` 设置。首次没有有效模型时，普通输入持久等待选择，不启动目录第一项；选择后按原顺序推进。已暂停的工作不会因为换模型而继续，仍需 `/resume` 或工作详情里的继续操作。

模型和思考等级在请求准备时冻结，正在进行的请求继续原参数；工具继续并保留结果，下一次请求采用最新设置。首页区分实际请求设置和期望设置。思考等级仅使用目录明确声明的集合，每个完整模型 ID 分别记忆；首次优先 `medium`，然后 `low`，否则最低支持等级。非推理模型不显示可调入口，声明推理但未给集合时说明能力未提供，不猜测 effort。Magpie 端思考控件延期于 [#243](https://github.com/CxHsin/nailong-bot/issues/243)。

面板可查看真实工作目标、取消指定工作、明确继续暂停项、查看现有缓存报表，并切换草稿预览。取消按已确认事实显示停止或待核实；发出中断不等于外部帮手已经停止。草稿默认开启，关闭只影响后续预览，最终文本、文件及发送回执照常交付。面板 reset 先说明影响并确认，再在安全边界重置上下文；它保留工作、helper、选择、等级、常用与草稿偏好。

升级时保留原 `ASSISTANT_DATA_DIR`。`MODEL_NAMES`、`MODEL_DEFAULT` 及旧主模型别名不再提供正式主助手目录，无法精确匹配 Magpie 的旧选择须明确重选，不能猜测映射。独立输入分类仍可使用下述 `MODEL_<ALIAS>_*`，无需为主助手逐模型配置。真实插件安装、双向回显及手机验收与自动化模拟结果分别记录。

## 数据与会话

`ASSISTANT_DATA_DIR` 默认 `data/pi-durable-v1`。升级本控制面板时继续使用现役目录，保留 Conversation、队列、取消标记、helper 和 Durable 已确认步骤。启动仍拒绝把退役的旧 Session 目录当作现役空间，不导入旧历史、摘要、工具轨迹、Akasha 或 Task。[ADR-0014](adr/0014-retire-legacy-code-and-data.md)结束旧实现和旧离线工具的支持，遗留数据由明确的一次性维护清理；普通启动不自动删除资料。

新空间分别保存完整输入与固定批次、主执行记录、会话控制与帮手材料，以及通道发送回执。已有外部 herdr 委派须保留并核对真实身份，不能因新会话没有历史就重新派发。工作目录由 `ASSISTANT_WORK_DIR` 指定，默认启动目录，重开会话沿用原目录；`AGENT_SHELL_PATH` 可指定 shell。工作目录与执行数据空间各自独立。

`AGENT_SYSTEM_PROMPT` 是实际基础指令文本，不能填文件路径；只校验非空，中文、引号和真实换行原样交给模型。按 [.env.example](../.env.example) 用引号包住多行值。旧 `AGENT_PROMPT_FILE` 和默认 prompt 文件入口已退役，升级须把操作规则迁入环境配置，把人设迁入 SELF。修改基础指令后重启服务，已有会话会采用新规则并保留历史、队列及工作进度；不需要 reset。

旧 Pi helper 身份导入及其配置已退役。现役空间中已登记的 helper 继续按原身份接回，启动无需旧会话目录；不能因旧目录不存在而重新派发外部工作。

新目录中，`queue.sqlite` 保存事件、批次及内部结果，`queue-owner.sqlite` 用于单服务独占，`assistant.sqlite` 保存会话控制、帮手身份和输出交付记录；各会话的 Durable 步骤位于 `executions/<会话标识的 SHA-256>/session.sqlite`，Telegram 发送回执位于 `telegram-sends.jsonl`。备份时停止服务并保留整个数据目录。

同一数据目录的 Telegram 与 CLI 不同时启动。`--full-access` 接受为可信执行声明，`--restricted` 拒绝，因为新版没有受限执行后端。

## 队列与命令

输入确认接收前保存来源身份、会话、正文、图片材料和顺序。重复投递的同一源消息去重；正文相同但身份不同仍是两条输入。每个会话一次执行一个主 agent 处理轮次，其他会话可分别推进。

原输入先持久接收。当前会话没有先前未完成工作或未交付 helper 时，原文直接交给主 Bot，不调用分类模型；存在排队、执行中、暂停或待确认工作、主 Bot 执行轮次或未交付 helper 时，由独立模型判断有序动作及实际工作目标。已完成、已取消的历史工作及已交付 helper 不单独触发分类，即使当前输入回复了历史消息。独立直接输入同级 FIFO；补充可关联当前、排队或已登记 helper 的目标，排队补充保留原位置。空闲或当前轮结束时领取已有输入的有限快照，先完成快照内关系判断或有界降级，不等待未来消息。命令、来源及优先级隔开批次；一批可包含多个目标，取消只撤销指定目标，其他项复用成果继续。

| 命令 | 行为 |
| --- | --- |
| `/help` | 显示用法 |
| `/start` | 打开会话控制面板，查看状态、实际请求与期望设置 |
| `/kvcache` | 即时查看当前会话最近五轮 prompt cache 用量，不等待主模型或工具结束 |
| `/model`、`/model 完整模型ID` | 查看 Magpie 目录或选择主模型；外部 Codex/Claude 模型不随之改变 |
| `/thinking` | 调整目录明确提供的思考等级，按模型分别记忆 |
| 自然语言补充 | 识别目标后按原顺序交给对应工作；主执行的普通补充不立即中止工具 |
| 自然语言取消 | 取消排队目标或尽快发起执行/帮手中断，保留成果；停止状态单独核实 |
| `/resume [批次ID]` | 明确继续本会话暂停的工作；省略 ID 时继续本会话全部暂停项 |
| `/reset` | 清主上下文，保留已接收事件、执行进度和帮手身份；不取消工作、不停止外部进程 |

旧 `/steer` 入口已退役，收到后提示直接用自然语言交办，不剥除前缀执行。连续补充保留各自来源身份；当前执行未消费时转为基于已有成果的后续处理。取消标记跨重启、reset 和 resume 保留。直接用户输入高于后台事件，可抢占低优先级轮次；未知外部效果仍先核实。

`ASSISTANT_INTENT_MODEL` 指向独立的 `MODEL_<ALIAS>_*` 配置，包含 API、BASE_URL、MODEL 和 API_KEY，独立于 `/model` 及 Magpie 主目录；不再需要 `MODEL_NAMES` 或 `MODEL_DEFAULT`。未配置时以 `not_configured` 原文兜底；非法别名或缺少凭据启动时报错。默认总超时 8000ms、估算输入 8192 token、输出 1024 token、近期 6 个用户轮次及确认助手文字，可用同前缀的 `TIMEOUT_MS`、`INPUT_TOKENS`、`OUTPUT_TOKENS`、`RECENT_TURNS` 环境变量覆盖。正整数及模型窗口校验在启动时完成。判断无工具、非流式且不重试；超时的迟到结果无效。

每条普通用户消息持久接收后立即触发路由处理，不等主 Bot 结束当前工作；同一会话按接收顺序判断，不等待凑齐几条消息。在处理队首消息时检查先前工作，空闲直通也持久保存为普通 request 决定，重启和重复投递复用该决定；连续消息中的后一条能看到前一条已建立的工作。每次模型判断提供三类材料：`current` 的用户原文、图片标记与 Telegram 被回复消息的 ID/角色/正文或 caption（不下载被回复的图片），`recent` 的近期用户与 Bot 交流，以及 `works` 的当前、排队和已关联后台 helper 的工作身份、简短目标和状态。`replyTargets` 是由真实回复身份关联出的工作 ID，未知回复仍保留消息信息但不猜造工作关联。没有前置用户消息的已确认 Bot 文字也可进入近期材料。

预算先保留当前消息及回复信息、工作身份与简短目标，再从最近轮次往前添加完整交流；遇到放不下的一轮即停止，不跳过它拼接更旧对话。省略工作候选会标记 `incomplete`，空摘要表示信息不足，不能仅凭残留一项或 running 状态猜选对象。原有 reset、遗忘及会话隔离继续过滤隐式近期材料。纯文字的省略表达结合三类材料判断；只有当前确有图片且这些文字信息仍不足以判断时，才要求视觉。接入与重测证据见[三类上下文修复](research/routing-three-context-evaluation-2026-10-17.md)。

Cloudflare 通用文本模型可通过现有 `openai-completions` 模型别名接入，base URL 为 `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1`，使用 Workers AI Token 和完整模型名。专用 Clef 入口已按用户要求删除，分类配置恢复为通用模型别名；历史结论见[旧评测](research/clef-joint-routing-evaluation-2026-10-17.md)。通用模型的合成 API 评测入口为 `scripts/acceptance/cloudflare-routing-live.ts`，读取已有 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`，不启动 Bot 或更改运行配置。

分类器对上述官方 Cloudflare 端点的 `@cf/qwen/qwen3-30b-a3b-fp8` 和 `@cf/zai-org/glm-4.7-flash` 请求 JSON Schema 输出，分别约束 request、supplement/cancel、clarify 的字段，并把 Schema 和额外提示计入输入预算。Qwen 在快照之后附加官方软开关 `/no_think`；GLM 发送 `chat_template_kwargs.enable_thinking=false`。这两条分类路径不使用 `reasoning_effort`。Qwen 的硬开关会使本次实测的 Cloudflare 正文为空，故不使用；不从 reasoning 字段提取控制动作。其他模型/端点沿用原协议参数。结构化输出仍需通过原文跨度、可见目标及候选完整性校验；不保证模型选择的目标语义正确，实测局限见[调用修复评测](research/cloudflare-routing-controls-evaluation-2026-10-17.md)。

Telegram 原消息和发送回执关联回复目标；一条回复对应多个目标时保留全部候选。图片无真实说明文字时直接兜底，保留原图；默认图片提示不充当用户意图。歧义、超时、预算不足或无效结果通过独立运行时材料告知主助手，原话及身份保留。

应用接口 `routingStatus(conversationId)` 可查看分类别名、待处理路由及工作身份/进度。`queue.sqlite` 保存原输入、快照来源、决定及动作进度；`assistant.sqlite` 保存补充提交、helper 控制证据和回复关联。未知 helper 发送不自动重发，CLI 接受不表示已采纳；helper 控制按真实身份分别推进，不等待主助手无关工具。

## 编码与恢复

herdr-workflow 负责派发、确认接收、转交要求、停止和独立成果核对；`herdr_watch` 只登记并观察已派发帮手。主 agent 可结束派发轮次并接收后续输入，helper 在独立上下文中执行，不把全部中间操作填进主会话。

回传先作为内部材料持久保存；当前轮结束后先处理已经排队的直接用户输入，再交给主 agent。它不进入普通用户消息队列，也不因回传本身直接发送 Telegram。主 agent 核查实际文件、差异与命令结果，不能把 idle/done 当作成果验收。重启查询原 herdr 身份与状态，不盲目启动替代任务。

意外退出后重开同一新空间，恢复已接收输入、原批次和已提交执行。已确认模型/工具结果复用，不通过重跑整个轮次重试单次请求。模型临时故障仅由执行器重试：最多 3 次，含首次共 4 次请求，基础等待 2 秒；底层 provider 不叠加重试。

重试耗尽后保留进度、暂停并通知一次，等待明确继续，其他输入仍可处理。重启保持主动暂停或待核实状态。工具与业务错误交回模型判断，不机械重试任意 Shell。外部操作结果不明时先核实：确认完成则采用结果，确认未执行才执行，无法确认则暂停询问。停止、抢占、重置都不能撤销已有影响。

cron、邮件、Slack、herdr 内部步骤恢复和服务器部署仍在范围外。旧 `run:diagnose`、`context:diagnose` 和 `migrate` 命令已退役，当前工作根据现役队列、Durable 与助手记录恢复。历史验收只适用于其记录的基准，进程强杀证据不能推导断电持久性或跨系统 exactly-once。

## 上下文与长期记忆

系统有效顺序为基础指令、skills 目录、项目指令、SELF 快照、MEMORY 快照，工具定义仍由 provider 编码器处理。恢复状态等动态材料追加到后续输入。每个压缩代保存实际 SELF/MEMORY 正文、版本及来源；普通更新通过有身份的增量即时送达同轮工具续步和其他会话下一输入，压缩或 reset 才归并。未变更的重启复用原快照及已投递增量；人工 SELF 修改在重启时更新基线，保留对话和执行进度。

`memory/SELF.md` 是身份、人设、相处原则、关系理解和表达习惯的权威当前正文，可直接编辑，启动不会由旧数据库正文覆盖。条目注释保存来源、版本及治理信息，正文可单独修改；新人工段落标为本地配置，不伪造用户引语。助手和后台提炼共用写入边界，后台只提炼关系/表达，身份和基础人设仅按当前明确要求修改。服务不逐轮扫描文件；运行期间人工修改后须先重启，避免覆盖冲突。

`assistant-memory.sqlite` 保存来源、版本、纠正关系、遗忘规则、检索及实际快照；MEMORY 与 topics 继续以数据库为准，Markdown 是可读导出。新空间初始化既定奶龙 SELF；现役旧生成 SELF 一次迁移有效条目及依据，保留人工修改并排除撤回条目，不读取退役 namespace。已初始化后丢失 SELF 会阻止启动，须先恢复文件；写入失败不会确认成功，文件 rename 后元数据中断须重启按实际文件核对，不能由旧数据库还原覆盖。

每条真实用户输入分别准备主题和 Akasha 原文召回，合批共享总预算；工具续步和 reopen 复用已记录结果，包括零命中。当前召回是本地词项/中文双字匹配，跨主题改述可能需要显式 `memory_search`；已知来源用 `memory_read` 分页。旧 Host/Akasha 未导入，工具全文保留在工具归档。

明确要求记住、纠正或忘记时，主助手调用 `memory_write` / `memory_forget` 立即处理。写入须引用真实用户原话并匹配当前版本；纠正使用 supersede，撤回使用 retract。压缩完成后的后台提炼只读取实际覆盖的原始用户记录，经相同治理边界写入，helper 只能提供候选。

默认忘记撤回派生记忆并持久排除相关来源及助手改写，立即清理快照、已保存的召回和追加材料；受影响摘要从存活原文及 Durable 记录定位重建，保留其他任务进度。reset 不遗忘长期记忆；默认忘记保留原始记录，不表示彻底物理删除。

## 工具原件、媒体与预算

长工具结果首次返回即落在 `executions/<会话 SHA-256>/archives/`，模型只接收状态、受限预览和 `archive:` 引用。已知引用直接 `archive_read`；未知引用通过 `archive_search` 按关键词、工具、命令、时间或文件定位。分页同时约束 UTF-8 字节和行数，超长单行使用 nextOffset 继续；搜索也有有限候选和游标。一次读取不自动预取下一页。原件与 Conversation 数据共同保留，无自动过期删除；索引损坏、无匹配和原件缺失会分别报告。

媒体保存在同级 `media/`，manifest 保留来源、类型和顺序。简单图片保持视觉输入；批量或大媒体在送入主模型前转为 manifest 与 helper 指引。高成本独立资料或媒体工作复用 herdr-workflow 和原 helper 身份，回传简洁结论及必要路径，主助手按需核验。浏览任务先确认 helper 能连接对应登录 tab。

Telegram document 附件保存在 `<dataDir>/media/telegram/<消息 ID>-<内容摘要>/`。单文件下载限制 20 MiB，元数据、响应长度与实际流均检查；下载限时 30 秒。PDF 提取最多 200 页、2 MiB 正文，模型先获得最多 12000 字节预览及原 PDF/完整文本路径；其余类型仅给真实保存路径。说明文字仍是用户原话，文件正文是资料。超限、下载失败或 PDF 无文字/损坏会明确回复；提取失败保留原 PDF，不做 OCR，不执行附件。

可选 `ASSISTANT_CONTEXT_CONFIG_FILE` 指向 JSON 文件，路径相对启动目录。可部分设置 archive、memory、media、compaction，其余使用默认值：

| 配置 | 默认值 | 目的/上限 |
| --- | --- | --- |
| archive.thresholdBytes / previewBytes | 16384 / 4096 | 在 SDK 保留上限前卸载；预览最大 8192 |
| archive.readBytes / maxReadBytes | 8192 / 32768 | 每页字节；硬上限 32768 |
| archive.readLines / maxReadLines | 100 / 500 | 每页行数；硬上限 500 |
| archive.searchLimit / maxSearchLimit / searchBytes | 10 / 50 / 8192 | 候选硬上限 50，响应预算最高 16384 字节 |
| memory.residentBytes / topicBytes / akashaBytes | 6000 / 3000 / 4000 | SELF/MEMORY 合计常驻上限；SELF 至多占一半，其余给 MEMORY；主题/原文另计 |
| memory.inputBytes / searchResults / readBytes | 8000 / 8 / 6000 | 每批自动材料总预算、显式搜索数、原文每页 |
| media.batchImages / maxInlineBytes | 3 / 524288 | 达到图片数或超过字节阈值时转 manifest |
| compaction | Pi Durable 1.2.0 默认策略 | 可覆盖 enabled、reserveTokens、keepRecentTokens、backgroundTokens |

预算是保守起点，不是模型最优参数。例如 `{"archive":{"previewBytes":2048},"memory":{"inputBytes":6000}}`。压缩沿用原生容量与后台机制，未增加固定空闲计时；配置较小模型窗口时须为 SDK 的输出安全余量留空间，真实验收采用 16000 窗口、6000 reserve、1200 keepRecent。

各会话 `requests.jsonl` 保存实际 provider 请求字节、模型、时间、延迟及 usage，不保存凭据和请求正文。未提供的 usage/cache 指标为 null；相同前缀不能证明远端缓存命中，配置价格为零也不能证明省钱。

`/kvcache` 在 Telegram 和 CLI 共用，展示最新五个实际发起模型请求的 Processing Turn；一次合批算一轮，工具续步、重试和同一批次的恢复归入同轮。报表按最近请求顺序排列，包含进行中与暂停轮次。Hit 使用 SDK `cacheRead`，Miss 使用 SDK `input + cacheWrite`，合计输入为两者之和，命中率按 token 加权；未返回的 cacheWrite 按零计。辅助摘要、记忆提炼和路由调用不混入主执行统计。

报表使用纯文本保留换行：每轮首行如 `1. 🟡 命中率：89.8%`，历史请求或运行状态提示放在下一行，Hit、Miss、合计输入及口感台词各占一行，轮次之间留空行。颜色与口感按未四舍五入的比例分档：>90% 🟢、>70% 至90% 🟡、>40% 至70% 🟠、≤40% 🔴；无有效命中率、待结算或数据缺失使用 ⚪，部分已知用量仍保留说明。Telegram 使用纯文本段落发送此报表，其他回复默认继续按 Markdown 展示。

每次请求以 requestId 写入 pending 和最终记录，查询用最终记录替换 pending；进行中的未返回请求提示“待结算”，结束或暂停后仍无 usage 提示“数据缺失”。缺少 input 或 cacheRead 的请求不当作零，若仍有其他有效请求，仅展示已知部分；明确零输入显示零 token、命中率不可用。查询不调用模型、不进入模型历史，按输入身份去重，报表为查询时的快照；reset、重启保留统计，会话隔离。升级前没有轮次/用途身份的旧记录逐请求显示为“历史请求”，不猜测归属，不能视为完整的逐轮统计。新实现与验证跟踪 [#231](https://github.com/CxHsin/nailong-bot/issues/231)，[旧报表说明](kvcache.md)仍仅作历史依据。
