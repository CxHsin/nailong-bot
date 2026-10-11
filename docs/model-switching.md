> 当前模型配置仍适用；原生 Session 行为见 [操作说明](personal-agent-operations.md)。

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


## 当前 Session 切换

/model 别名修改主对话原生 Session；持久模型 custom entry 随重启恢复，后台 Task 不同步切换。reset 会退役原 Session，旧在线 Projection 比例配置已不再作用于生产。跨端点历史兼容由 Pi SDK 负责，受控模型切换回归不证明真实服务缓存命中。
