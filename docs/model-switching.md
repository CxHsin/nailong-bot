# 模型配置与切换

所有生产模型从 `.env` 读取；模型别名、API 协议、Base URL、模型 ID 和密钥均可配置，不绑定服务商。Telegram 和 CLI 使用相同配置。

```dotenv
MODEL_NAMES=ds,gpt
MODEL_DEFAULT=ds

MODEL_DS_API=openai-completions
MODEL_DS_BASE_URL=https://api.deepseek.com
MODEL_DS_MODEL=deepseek-flash
MODEL_DS_API_KEY=在本地填写
MODEL_DS_REASONING=false
MODEL_DS_IMAGES=true

MODEL_GPT_API=openai-responses
MODEL_GPT_BASE_URL=https://你的中转地址/v1
MODEL_GPT_MODEL=你的模型ID
MODEL_GPT_API_KEY=在本地填写
MODEL_GPT_REASONING=true
MODEL_GPT_IMAGES=true
```

`ds` 和 `gpt` 只是例子中的别名，可换成 `primary`、`backup` 等小写字母开头、包含小写字母/数字/下划线的名称。在 `MODEL_NAMES` 中添加别名，再配置对应 `MODEL_别名大写_*` 即可添加模型。不要提交本地密钥。

`API` 目前支持 `openai-completions`（Chat Completions）和 `openai-responses`（Responses）。Base URL 包含服务要求的前缀，例如 `/v1`；协议不根据模型名称猜测。服务不支持相应工具、图片或推理能力时，应按实际能力配置并验收。

每个条目可设置 `CONTEXT_WINDOW` 和 `MAX_OUTPUT_TOKENS`，默认分别为 128000 和 16384；这是保守本地预算，不代表服务已核实的限制。`REASONING` 默认 false，启用后使用 low 级别；`IMAGES` 默认 true，不支持图片的模型应显式设 false。价格未知，SDK 零价格占位不代表免费。

已有上下文预算比例可按别名设置，例如 `PROJECTION_BUDGET_RATIOS={"ds":0.86,"gpt":0.86}`，无需知道内部 Provider 标识。

## 使用

- `/model`：查看当前模型和已经配置密钥的可选条目。
- `/model 别名`：切换当前 Conversation，例如 `/model ds` 或 `/model gpt`。

新对话使用 `MODEL_DEFAULT`；未设置时使用 `MODEL_NAMES` 的第一个条目，该条目必须已配置密钥。其他缺少密钥的条目暂不出现在可选列表。

切换排队等待当前任务结束，从下一轮生效；选择持久保存，重启和 `/reset` 后保留。CLI 指定同一 `--conversation-id` 时共享选择、历史和记忆。命令不进入模型上下文或长期记忆。主执行、历史压缩和静默摘要使用同一轮选定的模型。

更换中转只需修改该条目的 Base URL、模型 ID 和 API Key，并重启加载配置；不需要改代码。端点、协议或模型变化会隔离缓存身份和加密推理续接。同名条目的密钥变化不改写对话历史。已选择的条目被删除时，查询会标明配置已移除，普通模型调用明确失败；用 `/model` 选择其他模型即可，不自动回退。

## 兼容与投影

生产入口不再读取 `DEEPSEEK_API_KEY`、`XH_*` 和 `PROGRESS_MODEL`。本次已在本地 `.env` 补齐通用配置、迁移旧密钥而不输出密钥或覆盖已有条目；旧变量保留为迁移参考。旧应用和测试的 `createPiAgent` DeepSeek 参数暂保留兼容，生产 Telegram/CLI 始终使用通用配置。

继续复用原始事件恢复、工具归档校验、遗忘过滤和压缩边界，在实际 Provider 请求前执行原生投影。文字、图片、结算进展、最终回答及配对工具事实保留；专属推理只在同端点/协议/模型配置且带有效加密续接元数据时回放，跨配置移除专属签名。图片能力在请求前检查。原始运行历史、学习事实和已有交付保护保留。

每次请求（含重启后的首次请求）从当前 Conversation 的 runtime event log 恢复最近三轮历史及当前轮。每轮是一次用户输入和对应的可回放助手消息、成对工具调用与完整工具结果；近期历史归档恢复完整内容。更早历史保留，由 Akasha 检索相关旧记忆，不默认全量回放或摘要。三轮和当前轮本身超出 token 预算时，只压缩这个范围；旧的全历史摘要和含过期轮次的摘要不能复用。未完成任务恢复暂不处理。

## 验收

测试通过真实 Pi → 本地 HTTP/SSE 验证两种协议、独立密钥、跨模型工具/图片/历史、重启选择、历史压缩和摘要、错误不回退；另验证任意别名、默认模型、缺失/错误配置、端点变化后的身份隔离以及 Telegram 菜单与 CLI 续接。

真实服务模型可用性及容量仍需配置有效密钥后验收。本次不重启生产 Bot、不向 Telegram 发送测试消息，不新增重新交付或进展级别命令。
