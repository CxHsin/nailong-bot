# Jev 同类专用决策产品调查

调查日期：2026-10-16。本文核对公开的一手产品页、API 文档和定价；没有注册、充值或发起带密钥的推理。范围是用户指定的 TypeSafe Jev 及其他公司的同类专用决策产品。

## 结论

用户提供的 Jev 属于读取状态、回答调用者定义的封闭问题、返回选项概率的专用决策模型。符合这一接口和产品定位、且已经找到公开托管 API 与注册入口的替代品包括 **Bespoke Labs Nimble、Perplexity Decider、Nace.AI Drex、Cloudflare Clef、Fastino GLiDE**。它们能够在请求中给定业务类别和候选任务，不必先训练固定类别分类器；这与只负责在几个 LLM 间选模型的路由服务不同。

对 nailong 的中文上下文路由，建议先开 Cloudflare Workers AI 与 TypeSafe：先测 Clef-flash 和固定版本 Jev，Cloudflare 同账号还可比较 Clef。希望再加一个独立对照时选 Nimble（有验证邮箱试用额度）或 Perplexity Decider（公开单价更低，已有 Perplexity API Key 可直接使用）。Drex 和 GLiDE 是后续候选；GLiDE 的公开文档对思考行为存在不一致。此注册顺序依据接口和开通成本，并非准确率排名；本文没有本项目中文补充、撤销、回复定位的实际准确率证据。

## 可注册 API 对照

以下金额均为美元，单位为每百万输入 tokens，输出免费。输入计数口径因供应商而异，不能只据单价推定一次多问题请求的最终成本。

| 公司 / 模型 | 单价 | 注册入口 | 与 Jev 相似的能力 | 需要留意 |
| --- | --- | --- | --- | --- |
| TypeSafe `jev-1.13.0` / `jev-1.14.0` | $0.042 | [TypeSafe Console](https://console.typesafe.ai/) | 原生 System One；choice、score、noul；概率及置信度 | latest 目前指向 1.13，preview 指向 1.14；英语效果最佳，中文需测；账户资格与赠送额度未登录核实 |
| Perplexity `pplx-decider-v1.1-27b` | $0.02 | [Perplexity API Console](https://console.perplexity.ai/project/keys) | Decisions API；三类问题；文本、JSON、图像状态 | 任意 Perplexity API Key 可用；先创建 API project；API 预付费额度计费 |
| Bespoke Labs `nimble-v4` / `nimble-v4-max` | $0.04 / $0.09 | [Bespoke Console](https://console.bespokelabs.ai) | System One；state + questions；yes/no、choice、score；每选项概率 | 邮箱验证赠 $1；未付费组织并发 4；多问题共享文本只计一次，按 usage.input_tokens 计费 |
| Nace.AI `drex-v2.0` | $0.06 | [Nace Console](https://console.nace.ai) | 同类非生成决策；state + questions；三类问题；TypeScript/Python SDK | 注册赠 $25 有资格条件，有效 3 个月；还提供每月 $5；固定版本与 latest 要分清 |
| Cloudflare `@cf/cloudflare/clef-flash` / `clef` | $0.038 / $0.24 | [Cloudflare 注册](https://dash.cloudflare.com/sign-up) | System One 风格；三类问题；每选项概率；支持图像等输入 | 通过 Workers AI REST API 调用，需要 Account ID 和 API token；长文本状态会截断 |
| Fastino `fastino/GLiDE` | $0.15 | [Fastino 账号](https://agent.fastino.ai) | System One；三类问题；动态选项、概率与置信度 | 指南和 OpenAPI 的 thinking 行为不一致；不是完整的 TypeSafe SDK 即插即用替换 |

价格一手来源：[Jev](https://docs.typesafe.ai/models)、[Perplexity](https://docs.perplexity.ai/docs/getting-started/pricing)、[Nimble](https://docs.bespokelabs.ai/nimble/pricing)、[Drex](https://console.nace.ai/docs/drex/reference/pricing)、[Cloudflare](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[Fastino](https://docs.fastino.ai/pricing)。

## TypeSafe：Jev

- 用户提供的[发布文章](https://typesafe.ai/blog/introducing-system-one-models-and-jev)说明其架构针对有类型的决策而非自由文本生成。70–500ms 和速度倍数是厂商的特定实验结果，原文说明服务在美国西海岸、测试通常在西海岸笔记本上运行；不视为本项目中国网络下的端到端保证。
- 当前稳定别名 `jev-latest` 指向 `jev-1.13.0`；`jev-preview` 指向 10 月 14 日发布的 `jev-1.14.0`。两者均 $0.042/M input，输出免费；默认每请求 64K、每问题 32K，上下文计入状态及问题。评测固定版本，避免别名更新改变答案。[型号与价格](https://docs.typesafe.ai/models)
- 支持在请求中定义 Choice 候选（最多 255 项）、Score 等级、Noul 是非条件；同一状态可以并行问多个独立问题。TypeScript SDK 为 `@typesafe-ai/sdk`，也可直接 `POST https://api.typesafe.ai/v1/systemone`，从[Key 页面](https://console.typesafe.ai/keys)获取密钥。[快速开始](https://docs.typesafe.ai/introduction/quickstart)、[Choice](https://docs.typesafe.ai/primitives/choice)
- 官方明确英语是主要训练语言，CJK 可处理但效果不相等；1.14 发布说明称多语言是预期改善最大的部分，仍需中文实际评测。图片与长上下文已在 danger-zone 标头下实验开放，不能将默认文本模型表误读为完全没有图片能力，也不直接把实验功能当生产保证。[语言支持](https://docs.typesafe.ai/models)、[1.14 发布说明](https://typesafe.ai/blog/jev-1-14)
- “无幻觉”在此主要指封闭输出空间和类型约束，不代表业务判断不会错。官方 1.13 局限说明列出字面理解、多跳指代、干扰上下文、选项顺序及对抗内容等问题；这几项恰与我们的路由验收相关。[已知局限](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## Perplexity：Decider

- 官方 Decisions API 为 `POST https://api.perplexity.ai/v1/decisions`，当前模型 `pplx-decider-v1.1-27b`，也接受 v1。它返回 noul、choice、score 概率判断，不生成回复或解释。[官方指南](https://docs.perplexity.ai/docs/decisions/quickstart)
- 输入 $0.02/M，输出免费，无逐请求费用。计费输入含 state、所有问题和图片，以 `usage.input_tokens` 为准。每请求 1–128 问，Choice 最多 255 项，输入少于 262,144 tokens；每组织 10 requests/s。[指南及价格](https://docs.perplexity.ai/docs/decisions/quickstart)、[定价](https://docs.perplexity.ai/docs/getting-started/pricing)
- 任意 Perplexity API Key 可调用；[注册控制台](https://console.perplexity.ai/)支持 Google、Apple 或邮箱验证码等登录，先创建 API project，再[创建 Key](https://console.perplexity.ai/project/keys)。API 使用预付费额度，付款设置经 Stripe；普通网页聊天订阅不替代 API 额度。[登录](https://docs.perplexity.ai/docs/admin/signing-in)、[Key](https://docs.perplexity.ai/docs/admin/api-key-management)、[项目与计费](https://docs.perplexity.ai/docs/getting-started/projects)
- 官方指南报告 2026-09-30 小输入测试少于 2 秒，大输入随长度增长；这是官方测试，并非本地延迟实测。该指南没有给出本项目中文意图准确率，不能因其低单价就断言更适合中文。[官方指南](https://docs.perplexity.ai/docs/decisions/quickstart)

## Bespoke Labs：Nimble

- 官方明确定位为零样本文本分类、意图识别、路由、审核与评分：描述选项即可调用，不需要先训练分类器。入口为 `POST https://api.bespokelabs.ai/v1/systemone`。支持 TypeSafe Python SDK，也可直接 HTTP 调用。[概览](https://docs.bespokelabs.ai/nimble/overview)
- 当前 `nimble-latest` 指向 `nimble-v4`；`nimble-v4-max` 体积更大，官方明确说明费用和延迟更高。评测宜固定版本。每请求支持 1–64 个问题，choice 和 score 支持 2–255 个选项/级别。[概览](https://docs.bespokelabs.ai/nimble/overview)
- 每问题提示，包括状态，上限 256K tokens；请求体 1 MiB，超限返回错误。组织未购买额度时并发 4，首次购买后升为 100。[限制](https://docs.bespokelabs.ai/nimble/limits-and-errors)
- 文档写明邮箱验证赠 $1。首页宣传“worth 3k decisions”，是另一种宣传口径，不把它解释成固定免费请求次数。输出不收费，多个问题的共享状态和问题文本只收一次，以返回的 `usage.input_tokens` 为准。[价格](https://docs.bespokelabs.ai/nimble/pricing)、[注册页](https://console.bespokelabs.ai)
- 注册页比较 Jev 的分数来自 Bespoke 自己在 2026-10-12 对 Decision Index 公共子集的运行；页面明确说尚未登榜，公共部分仅占总榜 20%。不能把这个结果写成完整榜单上的独立认证，更不能据此声称中文更准。[注册页及比较说明](https://console.bespokelabs.ai)

## Nace.AI：Drex

- 官方将 Drex 定义为读取案例与给定选项、一次前向计算每选项概率的模型，不生成自由文本。接口为 `POST https://console.nace.ai/v1/systemone`；有官方 TypeScript/Python SDK 和 CLI。[产品](https://www.nace.ai/drex)、[快速开始](https://console.nace.ai/docs/drex/quickstart)
- 当前最新固定版本 `drex-v2.0`，`drex-latest` 在 2026-10-12 切到它。其为 35B 总参数、约 3B 活跃参数的 MoE；状态上限 131,072 tokens，状态加最长问题上限 262,144 tokens。超限拒绝。旧 `drex-v1.0` 为 $0.04/M、`drex-v1.5` 为 $0.05/M，2.0 为 $0.06/M。[型号](https://console.nace.ai/docs/drex/reference/models)
- 一次请求最多 512 个问题；choice 的标签及其描述在请求中传入，因此候选任务可以随请求变化。多问题共享状态，官方示例说明合并请求可减少重复输入 token。[问题类型](https://console.nace.ai/docs/drex/guides/questions)
- 新用户 $25 额度需要 Google 登录、至少 30 天的 GitHub 账号登录、或验证支付卡之一；仅邮箱验证码登录不自动满足。注册额度有效 3 个月，符合条件用户随后每月 $5，不结转。无需为获得额度同时开启自动付款；充值最低 $5。[快速开始](https://console.nace.ai/docs/drex/quickstart)、[价格与额度](https://console.nace.ai/docs/drex/reference/pricing)
- 官网提供自运行公共 Decision Index 和 JevBench 的结果，并明确公共集不等于含私有集的 Full 分数。其榜单数字用于识别可测候选，不代替中文真实路由评测。[产品评测说明](https://www.nace.ai/drex)

## Cloudflare：Clef

- `clef-flash` 是 9B 多模态决策模型，`clef` 是 27B；都接受状态和类型化问题，返回每个允许选项的概率。原生支持 noul、choice、score，一次最多 64 问。[Clef-flash API](https://developers.cloudflare.com/workers-ai/models/clef-flash/)、[Clef API](https://developers.cloudflare.com/workers-ai/models/clef/)
- Flash 上下文 24,576 tokens、$0.038/M input；Clef 为 65,536 tokens、$0.24/M input。两者输出免费。可以只发送文本或 JSON，不必使用多模态输入。[Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)、[Clef](https://developers.cloudflare.com/workers-ai/models/clef/)
- Cloudflare 账号可创建 Workers AI API token，直接 REST 调用 `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash`，无需先部署 Worker；API 结果位于 Cloudflare 外层响应封装内。[REST 快速开始](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- Workers AI 免费额度为每天 10,000 Neurons，按账号跨模型共享；这不是每天固定多少次决策。超出免费额度要 Workers Paid，付费仍有每日免费配额，按 Neurons 结算，官网同时给 token 等价价格。[价格](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- 定价页还列 `clef-omni` 为 $0.15/M input，但本次未取到模型页有效正文，未核实具体能力，因此不将它作为优先注册后的首测型号。[价格](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- 文档明确长文本状态会截断以适配剩余上下文。若候选任务历史在末尾或文本超长，需要由调用方控制预算，避免在评测中悄悄丢掉路由证据。[模型输入约定](https://developers.cloudflare.com/workers-ai/models/clef-flash/)

## Fastino：GLiDE

- GLiDE 是专用决策模型，API 为 `POST https://api.fastino.ai/v1/systemone`，文档使用模型 ID `fastino/GLiDE`。状态接受字符串、对象或数组；choice 接受调用者定义的 2–255 个选项；返回选择、每项概率与置信度。价格 $0.15/M input、输出免费。[调用指南](https://docs.fastino.ai/inference/systemone)、[价格](https://docs.fastino.ai/pricing)
- 每问题渲染后状态加问题上限 40K；`usage.input_tokens` 累加所有问题的内部 passes，可能高于 40K。没有 independent states 批处理。Score 返回的 `score` 是最可能级别的索引，`expected_level` 才对应概率加权级别；不能只换 endpoint 就沿用 Jev 的全部响应语义。[迁移与限制](https://docs.fastino.ai/inference/systemone)
- **思考行为证据有冲突**：发布博客和能力指南称先快速判断、对不确定案例自适应思考；但当前公开 OpenAPI 的 `SystemOneRequest` 写明省略 `thinking` 或 `false` 为 one pass，`true` 在 thinking pass 上线前拒绝。不能把宣传中的 thinking 模式写成当前已验证可开启的公共 API 能力。[发布说明](https://www.fastino.ai/blog/introducing-glide-the-first-thinking-decision-model)、[能力指南](https://docs.fastino.ai/concepts/glide-capabilities)、[OpenAPI](https://docs.fastino.ai/openapi.json)
- 官网注册按钮指向 `agent.fastino.ai`。本次未核到可明确引用的注册赠送额度，不承诺免费次数。[官网](https://www.fastino.ai/)
- 相邻产品 `GLiNER 2.5 Decide` 虽然更小更便宜，但官方能力页明确它是 **340M English model**，不把“Fastino 有多语言产品”当作这个型号适合中文的证据。[型号边界](https://docs.fastino.ai/concepts/gliner-2-5-decide-capabilities)

## 中文与动态任务定位如何解读

以上产品的动态 choice 选项可以承载当前候选任务 ID 及短描述；状态可带新消息、reply 线索和历史。可将“输入类型”与“目标任务”作为两个问题，但独立回答的多个问题不自动保证业务一致性，仍需要调用方处理“新任务却选择了旧目标”等组合。

现有 [intent.ts](../../src/assistant/intent.ts) 还要求按原文顺序输出多个动作及每个动作的原文片段。上述决策接口能直接覆盖类别和给定候选目标的选择，不能因此认定能原样替代整个 `actions[]` 生成合同。句内动作拆分、原文片段选择和顺序需要另外设计并验证；本次只调查，没有改分类器代码或既有降级规则。

本次读取的上述替代品页面没有给出本项目中文消息的可靠准确率或中文端到端延迟保证。能接受 Unicode、能用自然语言描述类别、模型基座可能多语言，都不是此任务已验证的中文效果。注册后应在同一批中文样本上比较：新请求/补充/取消/澄清、候选目标、无匹配、同主题不同任务、指代、省略及回复锚点；同时记录实际耗时和低置信度拒答比例。

## 未列入直接同类的产品

- **Not Diamond**：其 `modelSelect` 接收 `llm_providers` 并返回应调用哪个 LLM，优化成本、延迟、质量。它是模型选择服务，不能据此认定能直接输出 request/supplement/cancel 和业务任务 ID。[官方 API](https://docs.notdiamond.ai/docs/model-router)
- **Aurelio Semantic Router**：开源路由框架。现有 1.x 的 `DecisionRouter` 可以调用 TypeSafe Jev/Laya/Von，`IndexedRouter` 用嵌入匹配；因此可用作集成层，不是又一家独立 Jev 模型供应商。[官方源码 README](https://github.com/aurelio-labs/semantic-router)
- **SetFit、ModernBERT**：分别是少样本分类微调框架和 encoder 基座。需训练/部署及数据准备，不是用户注册就拿到动态 System One API 的同类产品；ModernBERT 的官方卡明确主要训练于英语和代码。[SetFit](https://huggingface.co/docs/setfit/index)、[ModernBERT](https://huggingface.co/answerdotai/ModernBERT-base)
