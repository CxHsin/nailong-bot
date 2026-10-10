# 记忆配置、恢复与诊断

规格 #49；实现 #50–#57。Runtime Event Log 是唯一事实源。Context、Memory 与 Telegram 分别消费原始事件，编排层合并原话、去重并记录实际展示。记忆不读取历史摘要；原始工具结果不成为记忆节点。

## 配置

在 `.env` 配置，修改后由维护者自行正常重启生效；测试不读取真实凭据或启动生产 Bot。

| 变量 | 默认/约束 | 含义 |
| --- | --- | --- |
| `EMBEDDING_BASE_URL` | 可选，HTTP(S) 基础地址 | 独立 OpenAI 兼容服务，例如 `https://example.invalid/v1`，不含 `/embeddings` |
| `EMBEDDING_MODEL` / `EMBEDDING_API_KEY` | 可选，三项齐全才启用 | 不默认使用聊天模型；凭据不写入运行日志 |
| `EMBEDDING_TIMEOUT_MS` | 3000，正整数 | 前台一次查询的整体远程等待上限；不是聊天总耗时保证 |
| `EMBEDDING_MAX_INPUT_CHARS` | 6000，正整数 | 长原话按 Unicode code point 连续切片后聚合，不改变节点或原始来源 |
| `MEMORY_MAX_TOKENS` | 4096，整数 0–4096 | 自动记忆引文及元数据总上限；还受输入预算 10% 约束，0 禁止额外注入 |
| `MEMORY_DYNAMICS` | `{}`，JSON 对象 | 覆盖下表动力学参数；Agent 召回及 Host 送达后学习使用同一配置 |
| `MEMORY_RECALL` | `{}`，JSON 对象 | 覆盖下表扩散边界；非法参数启动检查失败 |
| `PROJECTION_BUDGET_RATIOS` | 模型输入比率默认 0.86 | 例如 `{"deepseek/deepseek-flash":0.86}`；比率在 0 与 1 之间 |

`MEMORY_DYNAMICS` 的时间单位为毫秒。默认 `strengthMs=604800000`（7 天）、`edgeMs=1209600000`（14 天）、`resourceMs=1800000`（30 分钟），都是指数时间常数，不是半衰期。其他默认值：`strengthCap=3`、`edgeCap=2`、`strengthRate=0.18`、`edgeRate=0.12`、`resourceRate=0.35`、`backwardRatio=0.25`。时间常数和上限必须大于零，速率非负，资源速率及回指比率不超过 1。

`MEMORY_RECALL` 默认 `localMs=1800000`、`maxSeeds=16`、`maxLocalNodes=256`、`maxTransitions=8`、`iterations=8`、`restart=0.3`、`hubPower=0.1`。所有参数为正数；节点、种子、转移与迭代数量为整数，其硬上限依次为 512、32、32、32；局部窗口不超过 1 天，重启率小于 1。例如 `MEMORY_RECALL={"maxSeeds":12,"iterations":6}`。

预算是估算，不是服务商 tokenizer 的精确读数：完整 system、工具定义、消息、角色和来源包装按序列化 UTF-8 字节数 / 3 加结构开销估计；图片另保守预留。先为记忆预留额度，再压缩当前历史，最终检查合并输入。即使默认上限内也可能只引用长节点的一小段。Top-8 是学习资格集合，不是所有注入的条数上限，也不会由未展示的第九名补位。

## 初始化与服务降级

首次普通请求固定此前日志前缀，后台按各历史轮次当时的可用消息与原始送达结算时刻模拟。进度和前缀摘要写入原始日志；每一步检验固定来源，已提交的真实或模拟学习不再执行。模拟采用受预算约束的原始步骤重放，不复用今天的摘要，也没有 LLM 重要性裁判。

历史编码仅取得归档读取能力，模拟活动起点只用于临时范围；真实活动起点由在线 Context Projection 提交。该防护阻止历史初始化产生新的无效起点，不能修复旧版本已写入的损坏记录。若诊断发现活动起点前缀不匹配，保留原始日志，按 [上下文诊断](context-diagnostics.md) 只读核查；已有记录的恢复仍见 [#151](https://github.com/CxHsin/nailong-bot/issues/151)。

前台最多等待一次查询向量；缺失消息向量由后台补齐，不同步索引所有旧历史。HTTP 每批最多 16 个分片，后台单 worker，有界批量及 100 毫秒至 30 秒退避重试；后台长消息的每个 HTTP 批次分别受超时限制。服务恢复后继续补齐；缺少必要历史向量时初始化等待，但普通聊天、字面查询和可用图仍工作。初始化失败会记录降级，不冒充完成。

Telegram 持续显示前台准备阶段：读取记忆、等待语义匹配、扫描与相关性匹配的已检查条数、关联整理、排序、历史恢复、引用筛选、上下文装载及预算检查。扫描与匹配每 32 条或约 8 毫秒报告实际进度并让出事件循环；引用筛选每 16 条或约 8 毫秒报告已检查和已选入数量。进度合并刷新，快速完成的阶段可能被合并。没有可测总量的服务等待只显示当前阶段与等待时间，避免虚构百分比。取消检索不会发布完成或降级提示；这些状态不成为模型答复或记忆内容。在线范围遵循 [连续 Active Context](adr/0004-continuous-active-context.md)，历史初始化独立选择当时的原始因果前缀。

处理中优先使用 Telegram 原生 `sendRichMessageDraft`，不可用时由已有 transport 回退到 `sendMessageDraft`。同一 Run 保持相同非零 `draft_id`，让客户端动画显示文字变化；下一 Run 使用新 ID。每约 250 毫秒合并最新状态，未变化时每 15 秒刷新临时草稿。草稿只展示最近五项，终态保存完整可折叠进度卡片并独立交付答复。草稿失败或超时时回退到原有卡片编辑。实际动画由 Telegram 客户端决定，服务端不逐字调用 API，也不为动画拖延真实执行或最终答复。接口依据：[sendMessageDraft](https://core.telegram.org/bots/api#sendmessagedraft)、[sendRichMessageDraft](https://core.telegram.org/bots/api#sendrichmessagedraft)。

向量按服务、模型、预处理版本及实际维度隔离。新模型或已发现的新维度为未完成初始化建立独立 simulation/namespace 基线，沿用原始历史边界，跳过已提交轮次，不混用旧新向量。已冻结初始化和真实学习保持原记录；重建不重新召回来猜过去，也不把旧节点当成今日新生节点。未发现服务变化前，已有有效缓存仍按原 namespace 使用。

## 派生缓存恢复

记忆相关派生文件为 `data/memory.sqlite`、`data/embeddings.sqlite` 和 `data/memory-initialization/memory.sqlite`；当前事实源为 `data/runtime-v2.sqlite`，旧源文件与归档继续保留。索引核对用户、来源前缀摘要、消费位置及原话指纹；图每次从原始初始化、学习和排除事实重放。打开时检查派生数据库版本、表形状及 SQLite 完整性；缺失、损坏或不兼容时仅重建这些缓存，不改写原始事件或原始归档。权限/磁盘故障不被当成可随意删除的损坏。

通常无需手工重建。若维护者确实需要清空派生状态：先人工正常停止 Bot，确认所有请求与后台 worker 已结束，备份事实源，确认当前目录和 `data` 目录；只删除上述固定缓存及对应 `-wal` / `-shm` 文件。不要删除整个 `data`，不要删除 `runtime-v2.sqlite` 及其 `-wal` / `-shm`、`runtime.sqlite`、`runtime.sqlite-wal`、`runtime.sqlite-shm`、`events.jsonl` 或 `tool-results`。正常启动后的查询/初始化会重建索引和向量；语义补齐完成之前允许字面降级。

原始日志本身损坏不属于派生缓存恢复，不能用空库替换；应从可信备份恢复事实源。普通 `write`/`edit` 工具不得修改运行库、记忆库、向量库、检查点或归档，包括路径别名。

## 遗忘与诊断

回复目标 User 或已确认送达的 Assistant 页面发送 `/forget`，或使用 `/forget 节点引用`。当前 Host 将自然语言句子作为模型输入；遗忘控制使用斜杠命令。部分 Assistant 页面送达时仍可定位对应 User 轮次，但不把未送达 Assistant 全文纳入记忆。`/forget 模糊话题` 只列候选，等待明确选择。

排除原话、关联、后续上下文和来源工具回放，并使覆盖它的摘要失效。归档读取记录稳定来源身份，递归读取、原始 JSON、Windows 大小写和删除路径别名后的重启都不能自动复活来源。原始日志和归档仍保留；`/memory log 节点引用 [字符位置]` 是不调用模型的明确诊断，不恢复节点、不强化。同话题新消息可独立形成新节点；`/reset` 和缓存重建不会撤销排除。

日志关注：`memory_recalled` 的候选、来源、降级和配置快照；`memory_presented` 的实际引用区间与预算；`memory_initialized` / `memory_learned` 的冻结事实和 online/historical 身份；`memory_bootstrap_*` 的源前缀、进度和 namespace；`memory_excluded` 的意图及目标。降级原因包括 `embedding_not_configured`、`embedding_unavailable`、`memory_index_rebuilt`、`embedding_cache_rebuilt`、`recall_unavailable`、`bootstrap_unavailable`、`learning_commit_unavailable` 和 `exclusion_cache_cleanup_unavailable`。重建标签表示本进程观察到派生缓存恢复，不是丢失原始事实。

固定时间、相同模型向量与版本是严格重建召回等价的前提；换模型或服务暂不可用时只承诺保留原话、排除及已提交学习，不承诺排名不变。关联不是因果证明，仍可能错误召回。对照案例和资源结果见 [记忆对照验收](memory-evaluation.md)。实际聊天连续性与 Telegram 客户端草稿效果需要部署后由人补充观察，本次没有自动部署、生产重启或发送真实消息。
