> 历史材料：下文的结论、状态与验证属于原文日期和基准。现行职责见[相关 ADR](../adr/0013-contextual-input-routing.md)，运行方式见[操作说明](../personal-agent-operations.md)；本地规格归档的权威版本仍为原文链接的 Issue。

# 上下文决策分类模型注册与选型调查

用户随后澄清需要的是 TypeSafe Jev 一类专用决策模型。当前选型与注册建议见 [Jev 同类专用决策产品调查](system-one-decision-alternatives-2026-10-16.md)；下文保留此前对通用语言模型的调查，不作为该请求的选型结论。

调查日期：2026-10-16（北京时间）。针对 [#215](https://github.com/CxHsin/nailong-bot/issues/215) 中的中文 request、supplement、cancel、clarify 分类及目标定位；现有默认总超时 8 秒，输入预算 8,192、输出预算 1,024 token。本文是公开官方资料调查，不是实际延迟或准确率评测，没有注册账户、充值、使用新凭据或修改运行时代码。

## 注册建议

优先注册阿里云百炼，北京地域标准模型 API；一个账号先比较 `qwen3.7-flash-2026-07-15` 与 `qwen3.8-flash`，都使用非思考模式及严格 JSON Schema。国内供应商的具体型号、价格和开通来源见[国内一手资料](classifier-cn-provider-sources-2026-10-16.md)。需要独立平台对照时再开火山方舟，不必同时开通所有候选。固定快照优于随时更新别名，最终取舍需用同一组中文输入实测。

当前问题不只在模型：`src/assistant/intent.ts` 的 OpenAI 兼容路径没有发送 `response_format`，只用提示词要求 JSON；有 reasoning 配置时设置 low，没有按供应商显式关闭 thinking。Schema 能约束格式，不能保证语义定位正确、原文片段一致、目标属于本会话或 8 秒内完成，程序现有校验和降级仍须保留。注册后的接入应显式关闭思考并使用已确认支持的结构约束，不能只换模型名就据此认定旧问题已解决。

## 官方 DeepSeek：现有模型的直接接口对照

- 当前官方价格页列出 `deepseek-flash`，对应 DeepSeek-V4.1-Flash；支持非思考和思考，后者默认开启。[型号与价格](https://api-docs.deepseek.com/quick_start/pricing/)
- Chat Completions 需显式 `thinking: {type: "disabled"}`；`reasoning_effort: "low"` 仍是思考模式的计算强度，不能替代关闭开关。[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- 官方 JSON 文档确认 `response_format: {type:"json_object"}`，且提示 JSON 输出偶尔也可能为空；该文档没有提供可以据以宣称严格 JSON Schema 的保证。[JSON 输出](https://api-docs.deepseek.com/guides/json_mode/)
- 输入未命中缓存 $0.15–0.30、输出 $0.60–1.20 / 百万 token，取决于峰谷；缓存命中另价，不按零成本估算。[价格与峰谷时段](https://api-docs.deepseek.com/quick_start/pricing/)
- 注册及 API 管理入口：[DeepSeek 开放平台](https://platform.deepseek.com/)。直接官方接口可作为现有中转配置的对照；本调查未登录确认个人账户额度、充值及认证流程。

## 国际平台对照

以下是可研究的备选；对于中国大陆用户，地区可用性应先于注册投入。价格都是普通在线调用、每百万 token，不混用 Batch/Flex，也不把缓存价当普通输入价。

| 平台与模型 | 输入 / 输出美元价格 | 结构化与思考 | 注册优先级 |
| --- | --- | --- | --- |
| OpenAI `gpt-6-luna` | $0.10 / $0.50，短上下文 Standard | 支持 Structured Outputs；`reasoning.effort=none` 可关闭，默认 medium | 大陆不在官方支持地区内，不作为大陆直接注册首选 |
| OpenAI `gpt-5.4-nano` | $0.20 / $1.25，Standard | 官方明确包含 classification 用途，支持 Structured Outputs，none 默认 | 同上；有受支持地区条件时再评估 |
| OpenAI `gpt-4.1-nano` | $0.10 / $0.40，Standard | 原生非推理，支持 Structured Outputs | 可作非推理基线，但不因旧型号就认定更准确 |
| Google `gemini-3.5-flash-lite` | $0.30 / $2.50，Standard | 官方定位低延迟高吞吐、支持 Structured Outputs | 大陆不在 Gemini API 官方可用地区列表内，暂不作为注册首选 |
| Groq `openai/gpt-oss-20b` | $0.075 / $0.30 | 支持 strict JSON Schema；官方模型表输出速度约 1,000 token/s | 作为速度对照；中文目标定位、总延迟、地区注册与支付未实测 |
| Cerebras `gpt-oss-120b` / `qwen-3.8-27b` | 本次页面未取得可核对单模型价格，故不填写 | 官方确认 strict JSON Schema；目录标示约 3,000 / 1,850 token/s | 补充备选，不能把生成吞吐当本项目请求延迟 |

来源及注册入口：

- OpenAI：[Luna 模型](https://developers.openai.com/api/docs/models/gpt-6-luna)、[5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano)、[4.1 nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano)、[Standard 价格](https://developers.openai.com/api/docs/pricing)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[支持地区](https://platform.openai.com/docs/supported-countries)、[API 平台](https://platform.openai.com/)。
- Google：[3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)、[价格](https://ai.google.dev/gemini-api/docs/pricing)、[结构化输出](https://ai.google.dev/gemini-api/docs/structured-output)、[地区](https://ai.google.dev/gemini-api/docs/available-regions)、[AI Studio](https://aistudio.google.com/)。当前模型页将新项目引向 3.5 Flash-Lite 或 3.8 Flash，2.5 仅优先服务既有活跃用户，故不把旧 2.5 免费额度作为新注册依据。[模型目录](https://ai.google.dev/gemini-api/docs/models)
- Groq：[模型与价格](https://console.groq.com/docs/models)、[Strict Schema 支持矩阵](https://console.groq.com/docs/structured-outputs)、[快速开始](https://console.groq.com/docs/quickstart)、[API Key 管理](https://console.groq.com/keys)。模型表公布的吞吐不包含我们网络、排队与输入处理，不据此承诺 8 秒。
- Cerebras：[当前模型目录](https://inference-docs.cerebras.ai/models/overview)、[结构化输出](https://inference-docs.cerebras.ai/capabilities/structured-outputs)、[价格页](https://www.cerebras.ai/pricing)、[控制台](https://cloud.cerebras.ai/)。公开价格页注明添加有效支付方式可获一次性 $5、30 天有效的推广额度；这不是无限免费生产接口，个人资格未验证。

## 注册后如何比较

先用一个百炼账号比较上述两款模型，需要平台对照时再增加第二个平台。使用相同中文用例：独立新请求、跨无关消息指代、回复定位、多目标歧义、否定/取消、取消与新增的复合消息。保持真实工作候选和 8 秒超时，分别记下正确动作及目标、错误取消、格式失败、超时和端到端 P50/P95；发布吞吐或厂商一般基准不能替代这里的准确率与延迟。普通补充、取消分开统计，不只看最终主 Bot 是否兜底完成。

Schema 与关闭思考是注册后接入的明确适配点，本次没有实施代码改动。注册时只需取得平台自己的 API Key；密钥应进入本地配置，不写入研究笔记或聊天。
