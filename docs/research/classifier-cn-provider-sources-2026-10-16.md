> 历史材料：下文的结论、状态与验证属于原文日期和基准。现行职责见[相关 ADR](../adr/0013-contextual-input-routing.md)，运行方式见[操作说明](../personal-agent-operations.md)；本地规格归档的权威版本仍为原文链接的 Issue。

# 国内分类器 API 候选官方来源核验（2026-10-16）

访问日期：2026-10-16。目标是中文上下文 request / supplement / cancel / clarify 分类，现有总超时 8 秒、输出上限 1024 tokens。本文仅核验公开官方文档，没有注册、充值或调用模型；模型真实延迟、准确率与账号可开通范围尚未实测。

## 建议

优先注册阿里云百炼，选择北京地域标准模型 API，先比较 `qwen3.7-flash-2026-07-15` 与 `qwen3.8-flash`。前者在小上下文档位价格更低，两者都明确支持关闭思考和严格 JSON Schema。固定快照有助于避免模型别名升级改变评测结果；这属于实验选择，不能代替实际测评。[A1][A2][A3]

| 官方 API 模型 ID | 标准输入 / 输出价格，元每百万 tokens | 关闭思考 | 结构化输出 | 此次选择 |
| --- | --- | --- | --- | --- |
| `qwen3.7-flash-2026-07-15`（别名 `qwen3.7-flash`） | 北京，输入长度 ≤32K：0.2 / 0.8；32K–256K：0.6 / 2.4；256K–1M：1.2 / 4.8 | `enable_thinking: false`；默认开启思考 | `response_format.type=json_schema` + `strict:true`，也支持 JSON Object | 国内首选，8K 输入预算落在最低档 [A1][A2][A3] |
| `qwen3.8-flash` | 北京，0–1M：0.8 / 2.7 | 同上；默认开启思考 | 同上 | 国内能力对照 [A1][A2][A3][A4] |
| `qwen-flash` / `qwen-flash-2025-07-28` | 北京，≤128K：0.15 / 1.5 | 同上；旧型号默认不开思考 | 官方当前支持表只确认 JSON Object，未列入 JSON Schema 模型表 | 不作为严格 Schema 首选 [A1][A2][A3][A5] |
| `doubao-seed-2-1-turbo-260628` | 本次未读到有效官方价格正文，未知 | `thinking.type=disabled`；默认 enabled | 模型列表标注结构化输出，具体 JSON Schema 兼容范围本次未核实 | 第二平台注册备选，先补核价格和 Schema [V1][V2] |
| `glm-5.3-flash` / `glm-5.3-flashx` | 0.8 / 2.8；2 / 7 | **不支持关闭**，传 disabled 报错 | 支持 JSON；未证实服务端严格 Schema | 不符合此次明确不思考目标 [Z1][Z2][Z3] |
| `glm-4.7-flash` | 输入 / 输出免费 | 本次读取的旧模型页没有给出足够明确的关闭思考适用声明 | 官方结构化页使用 JSON Object、提示词描述 Schema 和客户端 jsonschema 校验，不能等同服务端严格 Schema | 仅作免费实验备选，非首选 [Z1][Z4][Z5] |

以上都是普通在线按量价格，不含批量折扣、缓存命中或临时促销。百炼其他地域/部署范围有不同价格与 Key，表中没有混用国际价格。[A1][A6]

## 百炼接入要点

OpenAI 兼容请求中，`enable_thinking` 是扩展请求字段，Python SDK 使用 `extra_body={"enable_thinking": False}`；直接 HTTP 则放请求体。仅把 reasoning effort 调低不等于关闭思考。[A3]

结构化配置为 `response_format={"type":"json_schema","json_schema":{"name":"routing","strict":true,"schema":{...}}}`。JSON Object 只能约束有效 JSON，不能保证字段、类型、枚举与指定结构一致。仍应保留应用现有的候选目标、动作和业务语义校验。[A2]

官方结构化输出指南还建议开启结构化输出时不要设置 `max_tokens`，避免截断生成内容。这与当前固定 1024 输出上限存在配置取舍：应在接入时用实际短分类输出测试截断风险与总超时行为，不能仅凭厂商文档宣称现有配置可直接无改动适配。[A2]

注册使用[阿里云百炼控制台](https://bailian.console.aliyun.com/)，[北京地域 API Key 页面](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)。[官方 Key 指南](https://help.aliyun.com/zh/model-studio/get-api-key)给出的北京兼容地址是 `https://dashscope.aliyuncs.com/compatible-mode/v1`。每个地域有独立接入域名、API Key 和模型列表，不能跨地域混用。本次公开页面没有核实新账号的实名方式、手机号/支付方式或全部地区注册限制，不对这些要求作保证。[A6]

## 火山与智谱注册信息

火山可从[官方方舟控制台](https://ark.volcengine.com/)进入；[模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=zh)与[深度思考](https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh)已实读。当前小型候选不是凭记忆填写的 Doubao Flash 名称，而是官方列表的 `doubao-seed-2-1-turbo-260628`。其默认思考开启，可显式 disabled；模型列表还说明限流非刚性保证，受平台负载和调用方式影响，不能据此承诺 8 秒。[V1][V2]

[火山价格页](https://docs.volcengine.com/docs/ark/model-pricing?lang=zh)、[结构化输出页](https://docs.volcengine.com/docs/ark/structured-output-beta?lang=zh)和尝试的 Key 管理页，本次 HTTP 多次返回应用空壳或没有目标正文的导航页，因此价格、严格 Schema 范围、确切 Key 页面、实名认证限制均未核验，不能编造数值。[V3][V4]

智谱[官方快速开始](https://docs.bigmodel.cn/cn/guide/start/quick-start.md)明确让用户到[开放平台](https://open.bigmodel.cn)注册登录，再进入 [API Keys](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)创建 Key。个人套餐、团队套餐与模型标准 API 的 Key 已分开管理，不互通；此次需要模型标准 API。最新 Flash 强制思考是其不作为首选的实际原因。本次未核实实名与区域限制。[Z6]

## 官方来源与本地证据

- [A1 百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)：读取千问 Flash 北京价格表及其他地域表，最低档价与输入范围见上表。
- [A2 百炼结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)：由旧 `json-mode` 地址跳转；区分 JSON Object 与严格 JSON Schema；支持模型表列 Qwen3.7/3.8 Flash；包含 max_tokens 建议。
- [A3 百炼深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)：enable_thinking、默认模式与支持模型列表。
- [A4 qwen3.8-flash 模型页](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)：确认 model ID、北京地域能力。
- [A5 qwen-flash 模型页](https://help.aliyun.com/zh/model-studio/qwen-flash)：确认旧别名等同 2025-07-28 快照。
- [A6 百炼获取 API Key](https://help.aliyun.com/zh/model-studio/get-api-key)：控制台入口、地域隔离与北京兼容端点。
- [V1 方舟模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=zh)：确认 Turbo ID、结构化标记、限流声明。
- [V2 方舟深度思考](https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh)：确认 Turbo 的 enabled / disabled 选项。
- [V3 方舟价格](https://docs.volcengine.com/docs/ark/model-pricing?lang=zh)：本次未获得有效正文，不能作为价格证据。
- [V4 方舟结构化输出](https://docs.volcengine.com/docs/ark/structured-output-beta?lang=zh)：本次未获得有效正文，不能作为 Schema 能力证据。
- [Z1 智谱 API 定价](https://docs.bigmodel.cn/cn/guide/start/pricing.md)：最新 Flash 价格与历史免费 Flash 表。
- [Z2 智谱 GLM-5.3 Flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md)：明确 model code、thinking.type 仅 enabled。
- [Z3 智谱深度思考](https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md)：明确 GLM-5.3 与 Flash 不支持关闭，disabled 报错。
- [Z4 智谱 GLM-4.7 Flash](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash)：旧模型 ID 与调用示例。
- [Z5 智谱结构化输出](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output)：已读 JSON Object 示例及本地 Schema 验证示例。
- [Z6 智谱快速开始](https://docs.bigmodel.cn/cn/guide/start/quick-start.md)：注册、Key 入口和产品类型隔离。

原始公开网页、提取文本和失败页面均保存于 `C:/Users/Cx/AppData/Local/Temp/classifier-cn-research-20261016/`，没有保存凭据。本文反映访问时页面内容，未把厂商宣传的速度/能力当作当前应用实测结果。
