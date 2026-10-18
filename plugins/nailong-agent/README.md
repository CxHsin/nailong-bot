# Nailong Magpie Agent

从仓库根目录运行 `magpie plugin add ./plugins/nailong-agent`，然后在 Magpie 的 Agent 页面连接 Nailong Bot 并选择模型。Nailong 首次启动会建立配置目录；配置默认在 `~/.config/nailong/magpie.json`，不随工作目录变化。

需要自定义位置时，给 Magpie 和 Nailong 设置同一个绝对路径环境变量 `NAILONG_MAGPIE_CONFIG`，安装 `magpie plugin add ./plugins/nailong-agent/custom.agent.js`，代替默认插件。Magpie 的插件运行环境没有 Node API，因此通过其原生配置路径环境变量展开机制实现覆盖。

JSON 的连接字段为 `baseUrl` 和 `apiKey`，共享模型字段 `model` 是 `magpie/` 加完整目录 ID。例如网关 ID `provider/team/model` 保存为 `magpie/provider/team/model`，请求仍使用 `provider/team/model`。其余字段保留；不要把连接凭据贴到日志或对话。Magpie 断开时按其原生语义还原这些字段，Nailong 停止新主请求并保留会话偏好。

模型共享只绑定 Telegram owner 的主 Conversation。其他 Conversation 自己保存选择。首版插件只声明模型字段；思考等级在 Telegram 设置。

接口依据：[Agent 插件文档](https://usemagpie.ai/docs/zh/plugins#agents)、[接入文档](https://usemagpie.ai/docs/zh/integrate)及 Magpie `d783df46cbac9021e26a6bd71ca0b55544552eb2` 的 `internal/agentplug/agentplug.go` 和 `internal/agent/plugged.go`。实现时本机版本查询为 `0.1.1285`；真实安装、菜单回显和断开恢复仍需实际接入验收，不能由模拟网关测试代替。
