# 工具、MCP 与 Skills

本体使用 Pi 原生 Session。常驻文件、命令、工作控制、权限提案、记忆及显式消息工具；网页检索、plan_control、working_agreements 及连接器专用能力使用配置模型支持的原生 tool search 按需发现。普通端点保留通用工具并报告发现不可用，不常驻专用 schema。工具定义进入上下文不授予执行权限。不支持原生发现的模型明确报告能力缺失；旧 tool_call 动态安装平台已退役。

`AGENT_CAPABILITIES_FILE` 指向 JSON。相对 skill 路径以配置文件所在目录为基准，不读取其他 Agent 全局配置。

```json
{
  "skillSources": [{"name":"personal","path":"./my-skills"}],
  "mcpServers": [{"name":"notes","url":"http://127.0.0.1:8080/mcp","timeoutMs":10000}],
  "executionTool": false
}
```

MCP 支持 Streamable HTTP 或 stdio，url/command 二选一；支持 headers 或 env/args。来源名不得重复或复用 local/memory/tinyfish。连接失败使启动失败并清理已建立连接。连接和列出目录不是任何工作的执行授权，关闭 Host 时释放连接。

本体轻量文件操作懒创建持久的整体工作；每个新输入默认独立范围，只有明确回复关联的工作才复用权限。整体工作复用主 Session，但文件工具的相对路径指向独立工作目录。read/write/edit 和 file_operation 的 mkdir、移动普通文件验证实际物理路径、硬链接及运行数据保护。读写均保守拒绝多硬链接普通文件，防止目录内别名读取范围外原文或 Agent 持久数据。移动不覆盖已有目标。删除原件需具体对象确认；用户可在范围内自主读取和修改文件。

work_permission 展示具体工作读目录、写目录、网络及有效期的提案。提案本身无权授予权限，只有随后由同一用户在同一对话确认具体动作后，Host 才持久保存；取消、过期及越界拒绝执行。工作补充要求保留既有目录和网络范围，旧具体动作批准仍因要求版本变化失效。普通新目标不继承其他工作的可信授权。

默认受限模式：没有满足读、写、网络和进程停止边界的已验证后端，命令与外部编码 Agent 在实际派发前受阻，不静默使用本机权限。运行时可通过 AGENT_CODEX_SANDBOX_EXECUTABLE 与 AGENT_CODEX_SANDBOX_EVIDENCE 登记已采样 unelevated 候选；当前实现仅给诊断并强制拒绝受限命令，不提供可执行的完整 Codex 沙箱。证据按物理执行文件/hash、OS release（不含 UBR）、政策摘要、7天有效期及采样目录匹配；字段异常或变更失配拒绝候选。任何 operator capability boolean 都不能把此实现升级为完整隔离。完整可执行后端仍需独立验证并增加适配器；不会隐式安装或修改管理员配置。详见[本轮实测](personal-agent-acceptance-20261013.md)。

一次工作明确获得可信本机权限后，普通 Shell 命令在该工作内自主执行，无需逐条命令确认。**可信 Shell 继承 Host 本机权限，不能强制保证不删除原件或不对外发送。** 本体应使用受控删除和发送接口获得相应明确授权；不能把目录写权限或提示词描述成语义隔离。配置 executionTool:true 仅允许 Task 提供命令工具，不替代工作权限。配置的独立检查以结构化 command/args 执行，同样匹配身份、当前目录/授权及能力；异步 supports 后再次核对权限快照。配置检查不构成受限权限绕过入口。

远端 MCP 与 Shell 分开检查，未分类连接器需可信权限、网络授权及具体工具动作确认；其权限不由 Shell 沙箱提供。配置代码提供的受控能力适配器须有明确 authorizer，自行落实该工具的边界；这不是把发现记录当作授权。herdr 没有独立验证过的受限执行策略时，在创建外部工作区前阻止派发；可信执行仍需明确外部 Agent 的目标与影响。

send_message 只向当前工作所属用户的当前对话报告完成、受阻或需决定的信息，不支持其他收件人或文件上传，无需重复审批普通本对话回复。它走持久 Delivery；unknown 保留待核对，不自动重发，分页与明确重交付继续由 Channel/Host 处理。子成果已通过工作事件回到主 Session，子完成不直接发送 Delivery。

修改、命令及专用工具派发保存稳定动作身份，已成功结果可复用；失败可能已有副作用，保存 unknown 并阻止自动重复。Session 结束不证明外部进程树已停止；缺少实际证据时保留未知占用。

Skills 指令、工具输出、网页和历史资料都不能扩大 Host 授权。TinyFish key 配置后可发现查询能力，不提供浏览器或桌面操控。当前架构和数据位置见 [README](../README.md)。

## 研究来源证据

Tinyfish 搜索是明确网络授权下的受控发现能力，搜索片段不等于页面原文。web_fetch 在派发前验证单个无凭据 HTTP(S) URL；成功才保存实际 provider-returned content、requested URL、SHA256、适配器版本及 owner/root 工作身份，回执放在 ActionDispatch evidence，不放进模型可写的工作目录。没有独立 response URL/HTTP 状态/新鲜度证明时不捏造这些事实。多 URL 组合响应未建立可靠页面映射，因此不作为每页原文回执。

孩子 submit_material 和本体 complete_work 可以提供 reference URL、receiptId、真实摘录及支持结论；本地路径仍兼容并标为 local。验收从同 root 成功受控账本核对远端证据，任意 MCP 返回 details、模型生成文件或单独 URL 都不能冒充真实远端检索。无效已声明来源保留 invalidMaterials 并保持 partial，即使另有有效文件。跨 root、owner、URL、hash 或摘录失配均不能通过。provenance 证明检索事实，本体负责结论与目标判断。

NativeCapability 的受控 retrieval adapter 与 authorize 分开，provider/version 进入定义指纹。普通 MCP 不自动获得这项语义，也不因 Shell 后端能力而获得执行权限。
