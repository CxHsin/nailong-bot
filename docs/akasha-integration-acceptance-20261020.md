# Akasha TypeScript、独立 Embedding 与模型菜单接入验收

日期：2026-10-20（Asia/Shanghai）。正式规格 [#268](https://github.com/CxHsin/nailong-bot/issues/268)，设计 [ADR-0017](adr/0017-port-akasha-engine-and-independent-embedding.md)，集成验收任务 [#277](https://github.com/CxHsin/nailong-bot/issues/277)。基准为文档提交 `769e39e`；实现集成在 `development`，已包含独立配置提交 `ef0aa14` 与菜单提交 `71865fb`。本记录编写时核心、宿主及新增测试尚有未提交差异；最终受检提交、全仓检查和评审结论须在全部相关写入者停写后补入，当前不据本记录宣称整个规格已验收完成。

## 实现与行为入口

[核心](../src/assistant/akasha)固定对照上游 [94027a5cce9fc494f20bb7931fddf26f1e15e8df](https://github.com/kachofugetsu09/akashic-agent/tree/94027a5cce9fc494f20bb7931fddf26f1e15e8df)，保留 MIT 许可，包含 dense/BM25、上下文/时间证据、动态图、扩散、激活/抑制、V8 读出及因果学习循环。[现役适配](../src/assistant/akasha-memory.ts)为原始来源提供检索，为合法闭合经历维护图；[学习资格桥](../src/assistant/akasha-learning.ts)读取真实 Queue 和 Durable 提交关联，防止把来源存在或工具前文本当作完整问答。MEMORY、SELF、主题、快照与 Durable 保持现役职责。

主要自动化边界是 Assistant Service 的 `receive`、`controlSnapshot/control`、真实发往模型的 HTTP 材料及 reopen，面板另通过原生 grammY 更新/回调验证。SQLite、队列、Durable 和配置编解码使用真实临时实例；进程外受控 HTTP 服务提供聊天、Embedding、Magpie 目录及 Telegram API 响应。受控向量证明确定行为，不作为真实 Embedding 质量证据。

| 规格用户故事 | 行为及证据入口 | 当前证据范围 |
| --- | --- | --- |
| 1–7 | [语义召回](../test/assistant-akasha.test.ts)、[图关联](../test/assistant-akasha-graph.test.ts)、既有原文读取与 Tool Archive 回归 | 跨措辞、实际注入、角色/时间/来源、主动搜索；图场景最终结果待集成汇总 |
| 8–12 | [既有记忆](../test/assistant-memory.test.ts)、[语义召回](../test/assistant-akasha.test.ts)、[失效](../test/assistant-memory-invalidation.test.ts) | 档案、逐输入材料复用、空结果/故障区分、范围与预算；全仓回归待最终记录 |
| 13–15 | [学习](../test/assistant-akasha-learning.test.ts)、[图关联](../test/assistant-akasha-graph.test.ts) | 7 项学习测试通过；未来关联的图场景待最终汇总 |
| 16–18 | [图关联](../test/assistant-akasha-graph.test.ts)、[在途遗忘](../test/assistant-akasha-race.test.ts)、[既有失效](../test/assistant-memory-invalidation.test.ts) | 当前消费、派生来源、旧空间及后台提交的最终竞态结果待汇总 |
| 19–25 | [学习](../test/assistant-akasha-learning.test.ts)、[空间与恢复](../test/assistant-akasha-space.test.ts) | 仅现役资料、有效原文与闭合资格区分、无新查询历史补齐、重启幂等、后台恢复与取消 |
| 26–33 | [Embedding 控制](../test/assistant-embedding-control.test.ts)、[模型菜单](../test/assistant-model-menu.test.ts) | 本地列表/环境初始项、持久选择、脱敏、合成连接测试；最终组合结果待汇总 |
| 34–36 | [Embedding 控制](../test/assistant-embedding-control.test.ts)、[语义召回](../test/assistant-akasha.test.ts)、[空间与恢复](../test/assistant-akasha-space.test.ts) | 未配置/错误/超时等继续聊天、降级保存、后台无查询恢复 |
| 37–40 | [空间与恢复](../test/assistant-akasha-space.test.ts)、[模型菜单](../test/assistant-model-menu.test.ts) | 同维度不同服务隔离、维度变化、迟到结果、新选择重建及主/路由独立 |
| 41–50 | [模型菜单](../test/assistant-model-menu.test.ts)、[原生控制面板](../test/assistant-control-panel.test.ts)、[模型控制](../test/assistant-model-control.test.ts) | 单入口三选择、思考位置、完整 ID、命令、忙时操作与暂停契约；手机观察未执行 |
| 51 | [学习](../test/assistant-akasha-learning.test.ts)、[空间与恢复](../test/assistant-akasha-space.test.ts)、[既有失效](../test/assistant-memory-invalidation.test.ts) | reset/reopen 保留选择、派生状态与遗忘；最终回归待汇总 |
| 52–53 | [原 Python 夹具](../test/fixtures/akasha/README.md)、[特征](../test/assistant-akasha-features.test.ts)、[核心](../test/assistant-akasha-engine.test.ts) | 核心 11/11 通过；Python 仅为开发对照，无生产 Python worker |
| 54 | 下文真实接入与交付状态 | 区分自动化、真实接口、手机和生产，不以 HTTP 200 替代集成证明 |

此表为覆盖导航，待汇总项不标作已通过。规格中的原生控制鉴权、过期/重复回调和既有记忆保证仍需最终完整项目测试覆盖。

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

图联想、遗忘竞态、原生模型菜单组合、最终 `npm run typecheck`、`npm test`、`npm run build`、`npm run docs:check` 和 code-review 结果尚待集成负责人更新。上列定向结果不替代这些完成条件。

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

当前完成的是代码接线、上述定向测试及独立临时空间真实 Embedding 验收。最终稳定源码的全仓检查、评审修复、提交身份和完整规格完成结论由集成负责人补入本记录。生产现役历史的全量补齐、手机按钮观察及真实主模型响应质量不由这次合成验收证明。

未执行生产进程重启、生产 Telegram 发送或 PR 合并。推送及 PR 状态按用户明确授权和实际动作记录，构建或提交不表示生产已经切换。配置、存储、后台恢复和故障处理见[操作说明](personal-agent-operations.md)。
