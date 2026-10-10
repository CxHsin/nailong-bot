# 工具发现、MCP 与 skills

规格与任务：#111、#112、#113、#114；连续上下文及 Telegram 命令扩展：#127、#130。

Host 每次 Run 固定当前能力版本。`tool_search`、`read`、`write`、`edit`、`web_search` 是稳定入口；TinyFish 未配置或连接失败时，`web_search` 明确返回不可用。`ls`、`find`、`grep`、记忆工具、`web_fetch` 和外部 MCP 工具通过 `tool_search` 发现。搜索按名称、说明及参数描述确定性排序，返回完整 schema、来源与 digest，默认最多五项，可指定 1–10 项。空结果可以修改查询；同轮已发现的工具可以重复调用。

兼容路径用 `tool_call({name, arguments})` 调用搜索返回的准确名称；Run 开始时不暴露全部延迟 schema。未发现的工具和无效参数被拒绝。原生路径直接调用已发现的工具。历史工具调用和搜索不会授权新 Run。重名工具全部使用 `来源__原名称`，与稳定工具重名时同样限定来源。

## 独立配置

设置 `AGENT_CAPABILITIES_FILE` 指向 JSON 文件，Telegram 与 CLI 都使用它。相对 skill 路径以配置文件所在目录为基准。默认不读取 Codex、Pi 或其他 Agent 的配置。

```json
{
  "skillSources": [
    { "name": "personal", "path": "./my-skills" }
  ],
  "mcpServers": [
    { "name": "notes", "url": "http://127.0.0.1:8080/mcp", "timeoutMs": 10000 },
    { "name": "scripts", "command": "node", "args": ["D:/tools/script-mcp.js"] }
  ],
  "executionTool": false
}
```

MCP 支持 Streamable HTTP 和 stdio，`url`/`command` 二选一；可配置 HTTP `headers` 或 stdio `env`。来源名使用小写字母、数字、连字符、下划线，不能复用 `local`、`memory`、`tinyfish`。连接失败会记录不可用来源，其他来源和本地工具仍可使用。连接由 Agent 关闭时释放。

`executionTool: true` 显式启用延迟的 Pi `bash` 工具，运行时需要可用 Bash；也可通过 MCP 提供执行能力。执行工具运行在 Bot 进程权限下。安装 skill 不执行脚本、不安装依赖；读取脚本正文也不会执行代码。

## Provider 协议

模型 `API` 可设为 `openai-completions`、`openai-responses`、`anthropic-messages`。`MODEL_<别名>_TOOL_SEARCH` 支持：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 官方端点且满足已公布模型范围时使用原生；其他路径用兼容入口 |
| `native` | 操作者已核实当前 API、模型、端点支持原生协议；Completions 拒绝此设置 |
| `compat` | 使用本地搜索与 `tool_call` |

OpenAI Responses 使用 client-executed `tool_search_call`/`tool_search_output`。当前 Pi SDK 忽略搜索调用块，Bot 在适配器中解析 SSE。加载 schema 随结果追加，五个稳定声明不变。Anthropic 使用普通自定义搜索返回 `tool_reference`；每次发送同样的完整目录，延迟定义标记 `defer_loading: true`。

原生引用只在请求编码时生成。Runtime Log 保存通用搜索调用/结果与实际执行事实，模型/端点切换时不会回放其他 Provider 专属块。中继需显式核实并配置 `native`；原生请求失败不会静默更换模型。真实服务的 prompt-cache usage 是观测值，本地 wire 测试不证明固定命中率。

协议依据：

- https://developers.openai.com/api/docs/guides/tools-tool-search
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- https://agentskills.io/specification

## 三层 skill 加载

配置目录递归扫描 `SKILL.md`；技能名称必须与目录一致，使用最多 64 字符的小写字母、数字、单连字符，description 必须为 1–1024 字符。系统前缀只有名称、描述、来源、文件定位与 digest。正文和参考资源不预先展开到模型输入。

隐式匹配时，模型通过 `read` 读取完整正文。正文分页会提示下一页，最后一页只有在所有分页已读时才标记完整。单行过大时明确失败，可改用 Telegram 显式引用。相对资源路径以已加载 skill 根目录解析；多个可能资源提示歧义，使用完整路径即可定位。网页归档的分页仍由原有 `read` 处理。

Telegram 在消息或图片 caption 开头输入 `/lesson 帮我学习这一章`，模型执行前加载完整正文，作为普通任务排队并显示进展，保留图片和回复背景。来源限定为 `/personal:lesson`；真实名称支持连字符。首行可连续写多个引用，同技能去重后按顺序加载，无参数也可开始工作流。内置命令优先，同名技能通过来源限定调用，例如 `/personal:help`；`/skill install/update` 保持控制操作。带 `@当前bot` 后缀可执行，其他 Bot 后缀忽略。正文中间的引用、路径和 URL 不触发。未知或歧义引用整体失败，不部分注入，不调用执行模型。旧 `@lesson` 不再作为 Telegram 显式触发，但模型仍可按任务相关性选择技能。完整正文超过预算或资源缺失时明确失败，不静默截断。CLI 继续自然任务匹配后用 `read` 加载。

## 安装与更新

Telegram 和 CLI 可发送：

```text
安装 skill https://github.com/owner/repo/tree/main/skills/lesson
更新 skill https://github.com/owner/repo/tree/main/skills/lesson
/skill install https://example.com/lesson/SKILL.md
/skill update https://example.com/lesson/SKILL.md
```

单独发送链接是普通资料，不触发下载。支持公开 GitHub 目录/`blob` 链接和 HTTPS 直接 `SKILL.md` 链接；不支持私有认证、商店包或其他格式。GitHub 路径通过 commit 固定版本，目录资源一起安装。直接文件链接只安装正文，明确报告不含资源。

文件先写入 `data/skills/.staging-*`；校验路径、元数据、文件数量/大小后形成不可变版本，再原子替换 `data/skills/catalog.json`。包内链接、子模块和越界路径被拒绝。安装不自动覆盖同名；明确更新才替换指针，失败前原版本仍可使用。旧版本保留用于追溯，不在安装时清理。普通文件写入工具不能修改管理目录。

成功后下一次 Run 可调用新技能，当前 Run 的注册表与正文不变。Runtime 记录来源、commit（可得时）、包 digest 与结果；显式正文保存在 `skill_loaded`，隐式分页保存在 `skill_read` 和普通工具归档。

## 回放与验收

`capability_snapshot` 记录 Run 目录身份和不可用来源；`tool_discovered` 记录命中 schema；`capability_dispatched`/`capability_executed` 记录准确执行工具与结果。兼容 `tool_call` 保留实际来源信息，供 Akasha 展示/遗忘过滤和网页归档预览使用。

显式加载回放当时正文，隐式加载回放当时的读取结果，均不重新读取磁盘新正文。Host 的连续 Active Context、reset、forget 和完整输入预算继续生效；旧历史正文不因命令语法变化而重新解析。skill 指令不成为 Akasha 学习内容。动态发现不改变注册表缓存身份；真实目录或技能版本变化使相应输入配置失效。Context Projection 缓存版本已更新，旧派生缓存自动重建。

`test/capabilities.test.ts` 从 Host → 真实 Agent → 本地 Provider/MCP 验证原生与兼容 wire、冲突/离线来源、参数拒绝、同轮重复调用、新轮权限隔离、显式/隐式全文、资源按需读取、预算失败、原子安装更新、重启旧版本、脚本执行及无执行能力。`test/replay-cache.test.ts` 比较含加载事实的完整/增量回放和重启、reset、forget、损坏缓存恢复。现有跨 Channel、模型切换、记忆与网页归档回归继续验证原先边界。
