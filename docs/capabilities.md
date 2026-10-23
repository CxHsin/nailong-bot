# 能力配置

当前主助手使用 nailong 持久队列与 Pi Durable 1.2.0，见 [ADR-0011](adr/0011-durable-main-agent-and-conversation-queue.md) 与 [操作说明](personal-agent-operations.md)。模型/工具步骤由 Durable 执行器保存；输入按 [ADR-0013](adr/0013-contextual-input-routing.md)识别独立请求、自然语言补充和取消。执行继承本机账户权限，工作目录不是沙箱；用户授权和目标仓库规则继续约束范围。

## Skills、工具与连接器

沿用项目指令与 skills 发现，额外加载项目 `.agents/skills`，包含 [herdr-workflow](../.agents/skills/herdr-workflow/SKILL.md)。配置 `AGENT_CAPABILITIES_FILE` 可提供现有 JSON 连接器和 skillSources，路径相对该配置文件解析。MCP 工具按配置接入；设置 `TINYFISH_API_KEY` 时加入网页 search/fetch。仍在用的工具适配到 Durable，不提供通用旧 Pi 扩展兼容层。

服务提供 `herdr_watch` 登记已派发帮手的真实身份和 prompt；仅观察和回传，不启动工作。`send_file` 交付用户要求的本地产物，Telegram 发送实际文件，CLI 输出路径。发送未知时先核对记录，不盲目重复工具调用。

编码使用 herdr CLI，继承现有 Codex/Claude 的模型和账户设置。只读任务使用 workspace，代码修改按目标仓库规则使用 worktree/分支；主助手检查真实 diff、文件及命令结果。补充要求与停止先核对帮手身份，无法确认停止时保留现场。

## 模型

正式主助手和路由模型使用 Magpie 连接与模型目录。主模型按 Conversation 保存选择，路由模型由整个 Assistant Service 共用并独立保存；`/model` 打开模型菜单，`/model 完整模型ID` 选择主模型。连接、选择与升级方式见[操作说明](personal-agent-operations.md)。`MODEL_NAMES`、`MODEL_DEFAULT`、`ASSISTANT_INTENT_MODEL` 和 `MODEL_<ALIAS>_*` 不再决定正式入口的模型选择；测试中的显式模型注入不属于生产配置入口。

Embedding 使用独立本地配置和服务级选择；主模型、路由模型与 Embedding 的选择互不覆盖。herdr 外部 CLI 继续使用其自身的 Claude/Codex 模型和账户设置，切换主助手模型不会改变它们。模型调用失败返回实际错误，不自动更换模型。

旧自建 Tool Search provider 适配已退役，`TOOL_SEARCH` 配置不在新版入口启用该旧协议。新版通过 Durable 适配在用工具，不恢复旧适配器的发现回执或权限协议。历史对照见 [原发现记录](native-tool-search.md)。

## 边界

主路径无需填写权限 roots/expiry 或成果结算表单。发布、外发、重要删除与合并依对应授权处理。新版恢复已接收工作和已确认步骤；共享长期记忆、Akasha 原文召回和工具原件遵循 [ADR-0012](adr/0012-layered-memory-and-stable-context.md)。cron/邮件/Slack 连接器和旧会话导入仍在范围外。旧离线工具已按 [ADR-0014](adr/0014-retire-legacy-code-and-data.md)退役；历史报告仅保留原基准的证据，当前验收范围见 [切换记录](durable-assistant-acceptance-20261015.md)与[上下文验收](context-management-acceptance-20261016.md)。
