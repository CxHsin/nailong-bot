# 会话控制面板与 Magpie 模型目录讨论

2026-10-18，通过 `grill-with-docs` 逐轮讨论。本文记录已确认的设计方向与待定问题，尚未形成完整规格，也不表示功能已实现。完整结论确认后按仓库约定发布 GitHub Issue。

## 已确认

- 设计统一会话控制面板，模型和思考等级属于其中的入口。
- `/start` 打开首页，显示当前模型、思考等级、运行状态和等待工作数量；首版入口包括模型、思考等级、工作列表、缓存统计、会话操作。快捷命令进入对应页面。
- 工作列表覆盖正在处理、排队、暂停及后台帮手的工作；具体操作仍待确定。
- 会话操作提供继续暂停工作和重置上下文；重置前说明影响并确认。沿用当前 reset 保留队列、执行进度和帮手的语义。
- 首版增加草稿预览开关，工具活动展示设置暂不纳入已确认范围。
- 模型选择不再局限于 `.env` 中逐个配置的别名。用户希望菜单能列出当前可选模型，参考截图中的分页、当前项标记和服务名/模型 ID 展示。
- 用户使用 Magpie 管理供应商。采用 Magpie Agent 插件接入 Nailong Bot，Magpie 管理连接并提供模型目录。
- 模型与思考等级在 Nailong 的 Telegram 面板内选择；Magpie 的 Nailong Agent 行只提供连接开关，不设置当前会话模型。

## 已核实的接入依据

[Magpie Agent 插件文档](https://usemagpie.ai/docs/zh/plugins#agents)说明：插件可将应用加入 Agent 页，写入连接配置；省略 `agent.model` 时可只提供连接开关，由应用自己选择模型。`connect()` 能收到网关地址、Agent key 和模型目录，Magpie 模型变动会再次调用它。

[接入应用文档](https://usemagpie.ai/docs/zh/integrate)说明：`GET /v1/models` 提供用户打开的模型及已知的能力信息，包括模型 ID、显示名、思考等级、上下文和输出限制及图片能力。该页面关于“插件不能添加 Agent”的说法与插件页不一致；当前源码已有 [Agent 插件加载入口](https://github.com/yetone/magpie/blob/main/internal/plugin/agent.go)。落地前仍需核实用户安装版本。

参考 [pi-telegram](https://github.com/llblab/pi-telegram/tree/6b4db8a573416e2cbe60d44f6e38847cb6392348) 的主面板、分页列表、当前项标记和模型/思考相邻入口。它依赖宿主目录；截图本身不能证明任意服务的实时模型发现能力。Nailong 的 Magpie 接入以 Magpie 自己的目录接口为依据。

## 待定

- 忙碌时模型与思考等级变更的生效时机，以及用户可见的等待/生效反馈。
- 模型列表的全部/常用范围、点选后直接切换还是进入详情。
- 思考等级的默认值、按模型保存规则和能力变化时的行为。
- 会话设置的保存范围，重启、reset 及暂停工作续接时的采用规则。
- 目录刷新失败、模型下架、连接关闭或选中模型调用失败时的反馈与后续操作。
- 工作列表操作、草稿预览设置范围、连接配置格式和现有模型配置的衔接。

## 当前代码事实

- `src/assistant/runtime.ts` 在普通命令批次中处理 `/model`，查询和变更需要排队。
- `src/assistant/durable-executor.ts` 按 Conversation 保存模型；初始和每次切换都把思考等级设置为推理模型 `low`、其他模型 `off`。
- `src/agent/model-config.ts` 从 `.env` 中的模型别名构造静态列表；尚未对接 Magpie 目录。
- 本次讨论仅更新领域术语与记录，未修改功能实现。
