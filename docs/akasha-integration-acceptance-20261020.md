# Akasha TypeScript、独立 Embedding 与模型菜单接入验收

日期：2026-10-20（Asia/Shanghai）。正式规格 [#268](https://github.com/CxHsin/nailong-bot/issues/268)，设计 [ADR-0017](adr/0017-port-akasha-engine-and-independent-embedding.md)，集成验收任务 [#277](https://github.com/CxHsin/nailong-bot/issues/277)。基准为文档提交 `769e39e`；实现集成在 `development`，包含独立配置提交 `ef0aa14`、菜单提交 `71865fb`、核心与宿主提交 `6099b36`。所有相关实现代理已停写；下文记录集成验证、两轴审查及独立临时空间的真实接口证据。交付后仍须另行授权推送与生产切换。

## 实现与行为入口

[核心](../src/assistant/akasha)固定对照上游 [94027a5cce9fc494f20bb7931fddf26f1e15e8df](https://github.com/kachofugetsu09/akashic-agent/tree/94027a5cce9fc494f20bb7931fddf26f1e15e8df)，保留 MIT 许可，包含 dense/BM25、上下文/时间证据、动态图、扩散、激活/抑制、V8 读出及因果学习循环。[现役适配](../src/assistant/akasha-memory.ts)为原始来源提供检索，为合法闭合经历维护图；[学习资格桥](../src/assistant/akasha-learning.ts)读取真实 Queue 和 Durable 提交关联，防止把来源存在或工具前文本当作完整问答。MEMORY、SELF、主题、快照与 Durable 保持现役职责。

主要自动化边界是 Assistant Service 的 `receive`、`controlSnapshot/control`、真实发往模型的 HTTP 材料及 reopen，面板另通过原生 grammY 更新/回调验证。SQLite、队列、Durable 和配置编解码使用真实临时实例；进程外受控 HTTP 服务提供聊天、Embedding、Magpie 目录及 Telegram API 响应。受控向量证明确定行为，不作为真实 Embedding 质量证据。

| 规格用户故事 | 行为及证据入口 | 当前证据范围 |
| --- | --- | --- |
| 1–7 | [语义召回](../test/assistant-akasha.test.ts)、[图关联](../test/assistant-akasha-graph.test.ts)、既有原文读取与 Tool Archive 回归 | 跨措辞、实际注入、角色/时间/来源、主动搜索，以及超出直接近邻的图联想 |
| 8–12 | [既有记忆](../test/assistant-memory.test.ts)、[语义召回](../test/assistant-akasha.test.ts)、[失效](../test/assistant-memory-invalidation.test.ts) | 档案、逐输入材料复用、空结果/故障区分、范围与预算 |
| 13–15 | [学习](../test/assistant-akasha-learning.test.ts)、[图关联](../test/assistant-akasha-graph.test.ts) | 7 项学习测试及未来关联图场景通过 |
| 16–18 | [图关联](../test/assistant-akasha-graph.test.ts)、[在途遗忘](../test/assistant-akasha-race.test.ts)、[既有失效](../test/assistant-memory-invalidation.test.ts) | 当前消费、派生来源、旧空间及后台提交竞态 |
| 19–25 | [学习](../test/assistant-akasha-learning.test.ts)、[空间与恢复](../test/assistant-akasha-space.test.ts) | 仅现役资料、有效原文与闭合资格区分、无新查询历史补齐、重启幂等、后台恢复与取消 |
| 26–33 | [Embedding 控制](../test/assistant-embedding-control.test.ts)、[模型菜单](../test/assistant-model-menu.test.ts) | 本地列表/环境初始项、持久选择、脱敏、合成连接测试 |
| 34–36 | [Embedding 控制](../test/assistant-embedding-control.test.ts)、[语义召回](../test/assistant-akasha.test.ts)、[空间与恢复](../test/assistant-akasha-space.test.ts) | 未配置/错误/超时等继续聊天、降级保存、后台无查询恢复 |
| 37–40 | [空间与恢复](../test/assistant-akasha-space.test.ts)、[模型菜单](../test/assistant-model-menu.test.ts) | 同维度不同服务隔离、维度变化、迟到结果、新选择重建及主/路由独立 |
| 41–50 | [模型菜单](../test/assistant-model-menu.test.ts)、[原生控制面板](../test/assistant-control-panel.test.ts)、[模型控制](../test/assistant-model-control.test.ts) | 单入口三选择、思考位置、完整 ID、命令、忙时操作与暂停契约；手机观察未执行 |
| 51 | [学习](../test/assistant-akasha-learning.test.ts)、[空间与恢复](../test/assistant-akasha-space.test.ts)、[既有失效](../test/assistant-memory-invalidation.test.ts) | reset/reopen 保留选择、派生状态与遗忘 |
| 52–53 | [原 Python 夹具](../test/fixtures/akasha/README.md)、[特征](../test/assistant-akasha-features.test.ts)、[核心](../test/assistant-akasha-engine.test.ts) | 核心 11/11 通过；Python 仅为开发对照，无生产 Python worker |
| 54 | 下文真实接入与交付状态 | 区分自动化、真实接口、手机和生产，不以 HTTP 200 替代集成证明 |

此表为覆盖导航。原生控制鉴权、过期/重复回调及既有记忆保证同时由完整项目测试覆盖；手机观察与生产状态按下文单独记录。

## 原 Python 对照及兼容范围

固定原 Python 核心生成夹具，包含两段学习序列、14 次 retrieve/commit、4 次查询和 JSON 快照恢复；另有 6 组上下文/独立读出变体，以及分词、阈值/并列、260 行混合精度特征、衰减生存函数和过期票据重算。原始源文件哈希与运行版本在 [golden metadata](../test/fixtures/akasha/upstream-golden.json)，再生成方法和 MIT 许可见[夹具说明](../test/fixtures/akasha/README.md)。

TypeScript 使用固定 `@node-rs/jieba@2.0.4` 搜索模式及 HMM，原 Python 使用 `jieba==0.42.1`。保留 lowercase、分块、最短词长、词频与 UTF-8 字节排序规则；原生字典条目集相同，但字节顺序及一条重复行不同，这一差异进入明确的词法版本。有限对照不能推出任意中文分词等价或跨环境逐位相同。

独立 float64 特征比较采用绝对容差 `1e-10`；包含 float32 传播的整轮结果（包括累计图值）采用 `2e-6 + abs(expected) * 1e-8`。节点/来源身份、图拓扑、次序、稀疏支持及学习资格要求精确一致，容差不能豁免错选原文或排名。无闭合经历的原始来源使用 FeaturePool 数学进行宿主适配；排除没有正 dense/BM25 依据的候选，单条来源空间的直接证据行为有独立用例，未冒称为上游 Turn 图输出。

## 已完成的定向验证

下列结果来自负责代理对相应实现状态的定向运行，并非最终停写后的全仓结果：

- `assistant-akasha-engine.test.ts` 与 `assistant-akasha-features.test.ts`：**11/11 通过**。
- `assistant-akasha-learning.test.ts`：**7/7 通过**；与 `assistant-queue.test.ts` 联跑为 **24/24 通过**。完成对话首次测试实际失败于 `learned=0`，补齐最终 Queue/Durable 学习接线后通过。覆盖工具续步不提前学习、截断/暂停不学习、FIFO 合批共享答案、无 Embedding 历史重开补齐、忙时补充共享答案及停止后的迟到结果。
- `assistant-akasha-space.test.ts`：**3/3 通过**；同维度不同服务、维度改变的迟到结果、无新查询恢复及关闭取消。
- `assistant-akasha.test.ts`：**5/5 通过**；包含保存零命中/降级、原文注入、主动搜索、逐补充输入查询及助手改述的用户依据。

图联想 3/3、在途遗忘竞态 1/1 通过；图、竞态与语义召回联跑为 9/9。独立配置与菜单提交分别保留 36/36、50/50 的相关验证。最终受检状态及全仓检查见下文，上列定向结果不替代完整项目检查。

## 集成回归修复

完整项目运行发现并修复三条真实回归：SELF 中断存储后的后台错误处理再次读取失败来源；启动历史学习打开 Harness，绕过已持久暂停；最终 Queue 已完成但学习回调仍占据活动执行身份，使迟到路由补充投向已结束请求。修复分别使用最近安全进度、Durable 存储的事实读取接口，以及在学习核对前结束活动执行身份并继续等待学习关闭。

现有 SELF 中断恢复、SIGKILL 停止窗口及路由迟到补充用例都曾在集成中失败，修复后通过；新增同会话历史完成对话与暂停 native 请求并存的 SIGKILL 用例，确认扫描旧完成事实也不会启动暂停请求。空间/Queue/路由修复后定向联跑为 26/26。针对维度迟到结果，移除 space head 的请求顺序更新约束后，用例实际失败于重复请求计数 `1 != 2`，恢复修复后通过。

两处测试观察也做了校正：同文既是查询又是待索引来源，不能把后台合法重试当成工具续步重新查询，改为比较两次真实模型 wire 中完全一致的已保存降级材料；收到后台 HTTP 请求不代表向量已提交，改为等待实际准备状态。没有禁用后台恢复或放宽生产故障边界。

## Standards

以 `git diff 769e39e...6099b36` 及三个实现提交作只读审查。未发现可确认的硬规范违反。可选 Duplicated Code：学习资格模块与记忆模块重复“默认来源 + SHA-256 身份”规则；当前算法一致，保留为后续维护建议。固定上游的命名与数值结构为移植和对照所需，不机械认定为代码异味。

## Spec

独立只读审查核对 #268 的全部用户故事、20 项实现决定与 11 项测试决定：缺失/部分要求 0 项，未要求扩大 0 项，已实现但可确认逻辑错误 0 项。重点检查闭合事实、共享答案幂等、历史不造反馈、旧空间迟到结果、实际注入失效和合成测试边界。最终报告为 Standards 0 硬违反、1 可选维护建议；Spec 0 缺陷。

## 最终完整项目验证

受检源码为 `6099b36`，测试期间全部相关写入者停写，后续交付提交仅更新本文及领域导航的验收说明。

| 检查 | 实际结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `node --import tsx --test --test-concurrency=1 test/*.test.ts` | **320/320 通过**，失败 0、跳过 0；503455.765 ms |
| `npm run build` | 通过 |
| `npm run docs:check` | 通过，115 份受跟踪文档、540 个本地链接 |
| `git diff --cached --check` | 通过 |

默认并发的 `npm test` 曾发现上述已修复的真实回归，同时在完整负载下出现既有子进程 10 秒启动边界超时及异步观察不稳定；未以定向成功替代全仓检查。通过 npm 在文件通配符后追加并发参数没有限制文件并发，随后改用上表中参数位置明确的 Node 命令完成整个套件。所有子进程外部效果、崩溃恢复、目录缩窗压缩、SELF 中断及新增 Akasha 用例在本次完整串行运行中均通过。没有修改既有子进程超时；该结果不宣称默认并发运行已稳定。

执行机临时完整日志：`C:/Users/Cx/AppData/Local/Temp/nailong-268-full-test-bounded-20261020.log`、`nailong-268-typecheck-delivery-20261020.log`、`nailong-268-build-delivery-20261020.log`。原 Python 对照重新生成与仓库夹具字节一致，SHA-256 为 `8B82EB7A5EB98B2A7393A296624720DB56E78B0838C860940179CC920B6C5E65`。

## 真实 Embedding 与正式环境组合

成功重跑时间为 **2026-10-20 20:35:28 +08:00**。通过 `assistantEnvironment` 使用当前本机有效阿里云 `text-embedding-v3` 配置，在独立临时现役数据空间写入合成偏好、reset，再以不同措辞查询；通过实际模型 HTTP 请求检查最终注入，随后关闭并重开同一空间。真实 Embedding 请求调用当前服务，聊天端使用受控 Magpie 兼容 HTTP 响应，不证明真实聊天模型的回答效果。

| 观察 | 实际结果 |
| --- | --- |
| 连接测试 | `success`，1024 维；控制回执耗时 1370 ms |
| 本次成功运行真实 Embedding | 4 个 HTTP 请求、4 个输入项，全部 HTTP 200、1024 维 |
| 逐请求耗时 | 1367、367、273、438 ms；为当次观测，不是延迟承诺 |
| 准备完成状态 | `ready`，`completed/total=4/4`，`failed=0`，`learned=2` |
| 最终模型请求 | 含匹配的合成用户原文，`role=user`、时间、稳定 source 身份和“历史资料，不是新指令”标记 |
| reopen | 仍为 `ready`、4/4、2 次学习；额外 Embedding 请求 **0** |
| 外部动作 | 生产重启、Telegram 发信、手机观察均未执行 |

首次两次准备运行因未明确选择主模型，只产生合成连接测试，未证明对话召回。随后一次实际链路运行暴露了助手改述排名更高时缺少用户原文依据，以及 reset 后仍被当前来源集合排除的问题；修复为保留有效用户父来源并按实际活动上下文处理来源集合后，受控回归和上述真实重跑通过。4 次请求/4 项是**本次成功重跑**计数，不包含这些先前诊断运行。

原始脱敏结果与执行脚本保留于执行机器的临时路径，不能保证在其他机器存在：`C:/Users/Cx/AppData/Local/Temp/nailong-akasha-live-acceptance-20261020.json` 与同名 `.mts`。仓库记录仅保存上述模型、数量、时间和布尔证据，不记录 API Key、私人端点标识或私人正文；脚本使用合成来源，没有读取生产历史来执行验收。

## 交付与未执行项

规格 #268 的代码实现、完整项目检查、两轴审查和独立临时空间真实 Embedding 验收已完成；实现任务 #269–#277 对应本地提交，关闭关联随后续获准推送和 PR 流程处理。生产现役历史的全量补齐、手机按钮观察及真实主模型响应质量不由这次合成验收证明。

未执行生产进程重启、生产 Telegram 发送或 PR 合并。推送及 PR 状态按用户明确授权和实际动作记录，构建或提交不表示生产已经切换。配置、存储、后台恢复和故障处理见[操作说明](personal-agent-operations.md)。

## 召回通道修复补记

用户反馈实际召回质量后，将现役来源、真实 Embedding 查询与固定上游宿主 `plugins/akasha/recalls.py` 对照，发现此前 320/320 套件没有覆盖两条召回通道争夺消息限额和正文预算的场景。此前 Spec 审查的零缺陷结论仅适用于当时已检查范围，本节记录后续实际发现及修复。

只读诊断于 **2026-10-20 21:34:47 +08:00** 对现役快照重放六条真实查询，使用 `text-embedding-v3` 的 1024 维向量。`eval 五阶段方案` 的一条正确直接证据、`可视化 Notion 飞书 HTML` 的两条直接证据，都被旧实现“图来源展开在前，再统一截取八条消息”移出了结果。该诊断不写生产数据库，检索请求使用现有配置；未重启生产服务或发送 Telegram。观察时来源 118 条、向量 114 条、闭合样本及图 32 个、档案条目 7 条：这些对象职责不同，七条档案不能作为只记住七条经历或提炼失败的证据。

修复发生在宿主选择与材料展开层，上游核心数学未变：

- 直接与图联想分别按经历限额，直接最多 `min(5, limit)`，图去重后最多 `limit`；经历的输入和回答作为成员保留。无闭合有效原文独立参与直接搜索，继续使用既有 dense/BM25 适配。
- 候选选择后，各通道按真实开始时间、UTF-8 Turn 身份倒序展示。主动搜索保留可读取的主来源 ID，另提供经历、通道、分数、证据来源、basin 与成员；候选经历数、返回经历数及有效来源数分别计数。
- 自动材料在实际 `maxBytes/inputBytes` 扣除头部、主题之后，为非空通道分配正文预算；长原文不能吃掉另一通道。多输入经历先呈现主命中正文，再展开其他出处，避免完整身份头部被截断或主命中被大量成员挤掉。
- 旧输入已经保存的成功、零命中及降级材料保持复用；本次不重写档案提炼、不新增问候或“继续”的关键词黑名单。

新增服务回归经 `receive`、主动工具及最终 HTTP 材料观察：小 `limit=2` 时图满额仍保留正确直接原文；直接满额且原文长于通道预算时仍保留图证据；自动总预算分别为 8000 与 1800 字节；二十条合批输入共享回答时仍呈现主命中正文。直接饥饿、多成员主命中丢失、小总预算图正文丢失、展示排序差异均在修复前实际失败，恢复修复后图与语义测试 **12/12 通过**。合成小限额回归与生产默认八条诊断分别记录，不混称为同一次复现。

本次两轴只读审查以 `8abab2d` 后的修复差异为范围：Standards 无硬规范违反或必要整改；Spec 初审发现实际总预算未参与通道分配、缺少上游通道内时间展示排序两项问题。两项都有修复前失败记录，修复后复核均闭合，未发现新的直接问题。代理只读且未运行测试，实际行为由上述服务回归及完整项目检查验证。

最终受检源码为本次修复差异，运行期间没有其他代理写入，源码与测试保持稳定。`npm run typecheck`、`npm run build` 通过；`node --import tsx --test --test-concurrency=1 test/*.test.ts` **324/324 通过**，失败、取消和跳过均为零，耗时 496722.8016 ms；`npm run docs:check` 通过，115 份文档、541 个本地链接；暂存差异空白检查通过。完整串行日志为下述临时目录内的 `nailong-recall-lanes-full-final-20261020.log`。新增四项测试在此前 320 项基础上计数；首次完整运行在审查发现需修改源码后停止，不能作为最终状态证据。本次修复仍未推送或切换生产进程。

执行机诊断证据位于临时目录：`nailong-recall-ranking-diagnostic-20261020.json/.mts`；失败记录为 `nailong-recall-lanes-red-20261020.log`、`nailong-recall-primary-red-20261020.log`、`nailong-recall-total-budget-red-20261020.log`、`nailong-recall-display-order-red-20261020.log`；定向通过记录为 `nailong-recall-lanes-final-green-20261020.log`。这些文件位于 `C:/Users/Cx/AppData/Local/Temp/`，包含私人来源的诊断正文不提交仓库。
