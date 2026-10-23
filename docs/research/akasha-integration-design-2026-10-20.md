> 历史材料：下文的结论、状态与验证属于原文日期和基准。现行职责见[相关 ADR](../adr/0017-port-akasha-engine-and-independent-embedding.md)，运行方式见[操作说明](../personal-agent-operations.md)；本地规格归档的权威版本仍为原文链接的 Issue。

# Akasha 引擎接入与模型菜单讨论

日期：2026-10-20。用户已确认本讨论全部设计选择；本文是设计结论归档，不是实现验收或最终规格。权威结论为 [Issue #267](https://github.com/CxHsin/nailong-bot/issues/267)，按 [Issue tracker](../agents/issue-tracker.md) 发布。

## 问题与事实

现役 `AssistantMemory` 按真实用户输入自动召回，但使用词项和中文相邻双字匹配，没有读取 `EMBEDDING_*`，没有接入旧图内核。[ADR-0012](../adr/0012-layered-memory-and-stable-context.md) 记录了这一实现。用户要求接入上游 Akasha 的语义检索与图联想能力；后续设计需明确调整该选择，不能将现役字面匹配描述为上游引擎。

上游调查固定于 [94027a5cce9fc494f20bb7931fddf26f1e15e8df](https://github.com/kachofugetsu09/akashic-agent/tree/94027a5cce9fc494f20bb7931fddf26f1e15e8df)。其记忆核心使用 embedding 和算法完成检索、关联与学习；“无生成式 LLM 的记忆引擎”不表示不使用 embedding，也不表示整个 Agent 的 Markdown 提炼不调用模型。最小复用边界为 Python 的 `domain` 与 `application/cycle.py`；宿主消费、来源、模型和持久化仍需适配。上游为 MIT 许可，复用须保留许可声明。

本次已有单条合成文本真实接口证据：当前环境配置的 `text-embedding-v3` 返回 HTTP 200、1024 维有效非零向量，约 516 ms；此前另一端点返回 401。该证据只确认接口调用，不代表现役召回已接入。凭据不记录在本文。

用户指出 Magpie 似乎不能选择 embedding 模型。本机当前 Magpie `/models` 只读请求返回 HTTP 200，共 87 个模型；未发现名称或类型等可见字段标识的 embedding 候选。项目当前目录解码仅提供主模型与路由选择，未接入 embedding 能力。此观察不能推导所有 Magpie 版本永远不支持 embedding。

## 已确认决定

用户对上一轮三个推荐项回复“同意”：

1. 接入上游 Akasha 的向量检索、图关联、学习和召回能力，同时保留现有 MEMORY、SELF、主题档案、遗忘规则及 Durable 执行记录。
2. 后台补齐现役历史原文的向量，使接入前经历可被语义召回，同时处理新消息。允许相应 embedding 调用和用量；不恢复已退役旧 Host 数据，不改写原始记录，遵守现有遗忘与纠正。
3. embedding 故障时继续普通聊天，使用可用本地检索并明确记录降级，后台恢复处理。检索失败不能保存为一次成功的零命中。
4. Embedding 独立于 Magpie：本地管理服务与模型配置列表，Telegram 提供选择、状态和连接测试；首次使用已测通的阿里云 `text-embedding-v3`。选择由整个 Assistant Service 共用并持久保存；API Key 在本机管理，不通过 Telegram 配置。
5. 用户明确选择移植上游 Akasha 核心至 TypeScript，未选择 Python 工作进程方案。固定上游基准、保留 MIT 许可，并通过相同输入的对照验证数学、学习和检索行为。选择理由及与现役实现的关系见 [ADR-0017](../adr/0017-port-akasha-engine-and-independent-embedding.md)。
6. 切换 Embedding 时，新请求使用新模型，历史向量和关联后台重建；不同空间的向量及图不得混用。资料未准备充分时使用可用检索并显示进度，不偷偷继续调用旧模型。原始记忆保留；主模型或路由模型切换不触发记忆重建。
7. 有效历史原文可做语义检索；历史图学习只重放可验证已闭合及输入关联的对话。不能确认完整轮次的资料仍可检索，但不强行配对、不补造历史召回反馈。接入后的新对话记录学习所需事实。这里的闭合只表示一次处理结束，不代表用户整个工作目标已完成。
8. 首页只保留 `🤖 模型：gpt-6.1-sol` 一类简写按钮；打开后显示带当前选择简写的“主模型”“路由模型”“Embedding 模型”。思考等级移入主模型页面；Embedding 页面提供当前配置、连接状态、历史处理进度与测试连接。`/model` 无参数时进入该三项菜单。

菜单名称是展示简写，选择、保存和调用仍使用完整服务与模型身份，避免同名简写造成误选。主模型保持 Conversation 范围，路由与 Embedding 保持 Assistant Service 范围，三个选择彼此独立。带参数的 `/model <完整模型 ID>` 保留主模型切换用途。

## 保持的现役边界

沿用 [GLOSSARY](../../GLOSSARY.md) 的 Akasha Recall、Memory Snapshot 与 Default Forgetting 定义。现役来源拥有角色、时间、Conversation、inputId 与父来源，足够补建文本向量索引；来源行不等于上游已闭合学习轮次。历史图初始化须根据真实完成记录定义资格与顺序，不能补造历史召回反馈。

默认遗忘的来源递归排除、快照与摘要失效仍由现役契约约束，上游节点抑制不能直接替代。原始记录、记忆与 Durable 的执行事实保持职责分离。

来源记录时刻不冒充 Channel 接收时刻；历史适配保留 Queue 接收顺序、Durable 条目时间与来源身份的真实含义，缺失信息记录原因，不填造过去事件。工具归档保持现有全文与分页入口，不因接入图学习就把工具全文当作用户对话。

## 移植与接入验证要求

固定上游核心包括混合 dense/BM25 特征、时间和上下文证据、图关联、扩散、激活、抑制及读出。只增加 embedding 相似度或简化边权不能作为完整移植验收。上游中文分词使用 `jieba.lcut_for_search`，词序和并列排序也属于行为；不能用现役双字匹配或 locale 排序冒充等价移植。

以固定 Turn、原文、词频、向量、时间及反馈运行原 Python 核心，导出逐步图状态、查询票据及召回结果，作为 TypeScript 对照。运行生产环境不需要 Python 工作进程；验证阶段可以运行原核心生成对照。上游混用 float32 与 float64，数值比较须明确容差，同时验证排名、并列规则、学习拓扑和来源身份；不以浮点容差掩盖行为差异，不宣称跨运行环境逐位相同。

集成验证须经过现役 Assistant Service、Telegram 控制操作与实际记忆材料注入：真实配置的 embedding 生成有效向量，跨措辞历史召回，自动和主动检索，闭合轮次学习，重启复用，遗忘/纠正，超时/401/恢复及不同 embedding 空间切换。真实接口证据与受控测试分开记录。沿用现役快照、预算、项目范围、请求设置冻结和工作暂停契约。

## 交付状态

设计讨论已收敛，正式规格已发布为 [Issue #268](https://github.com/CxHsin/nailong-bot/issues/268)，见[本地规格归档](akasha-integration-spec-2026-10-20.md)。后续实现任务须按 Issue tracker 关联该规格。功能代码尚未修改，生产服务尚未重启，不能将本结论或先前单条接口成功当作 Akasha 已接入的证据。
