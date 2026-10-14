# 能力配置

当前主助手使用原生 Pi，见 [ADR-0010](adr/0010-native-pi-assistant.md) 与 [操作说明](personal-agent-operations.md)。文件、Shell、工具错误、压缩和 steering 由 Pi 处理，执行继承本机账户权限。工作目录不是沙箱；当前用户授权和目标仓库规则继续约束范围。

## Skills、扩展与连接器

原生资源加载器发现工作目录的 `.pi/skills`、`.pi/extensions` 和 Pi 支持的项目资源。接入配置额外加载项目 `.agents/skills`，包含 [herdr-workflow](../.agents/skills/herdr-workflow/SKILL.md)。配置 `AGENT_CAPABILITIES_FILE` 可提供现有 JSON 连接器和 skillSources，路径相对该配置文件解析。MCP 工具按配置接入；设置 `TINYFISH_API_KEY` 时加入网页 search/fetch。

服务提供 `herdr_watch` 登记已派发帮手的真实身份和 prompt；仅观察和回传，不启动工作。`send_file` 交付用户要求的本地产物，Telegram 发送实际文件，CLI 输出路径。发送未知时先核对记录，不盲目重复工具调用。

编码使用 herdr CLI，继承现有 Codex/Claude 的模型和账户设置。只读任务使用 workspace，代码修改按目标仓库规则使用 worktree/分支；主助手检查真实 diff、文件及命令结果。补充要求与停止先核对帮手身份，无法确认停止时保留现场。

## 模型

沿用 `MODEL_NAMES`、`MODEL_DEFAULT`、`MODEL_<ALIAS>_*` 配置；仅列出有 API Key 的别名。`/model` 查看或切换主 Session。主助手模型与 herdr 外部 CLI 模型各自配置，切换主助手不会改变 Claude/Codex。当前 ds 额度不足会返回实际模型错误，不自动改模型。

旧自建 Tool Search provider 适配已退役，`TOOL_SEARCH` 配置不在新版入口启用该旧协议。新版使用 Pi 原生工具和资源加载，不承诺旧适配器的原生发现回执、权限或恢复保证。历史对照见 [原发现记录](native-tool-search.md)。

## 边界

主路径无需填写权限 roots/expiry 或成果结算表单。发布、外发、重要删除与合并依对应授权处理。新版不接入 Akasha、任务调度、旧状态迁移或通用自动重启框架；离线诊断和历史报告不参与在线模型上下文。
