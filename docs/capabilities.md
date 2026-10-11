# 工具、MCP 与 Skills

当前能力直接交给 Pi 原生 Session；旧 tool_search/tool_call 延迟发现与动态安装入口已退役。当前架构见 [README](../README.md)。

`AGENT_CAPABILITIES_FILE` 指向 JSON。相对 skill 路径以配置文件所在目录为基准，不读取其他 Agent 全局配置。

```json
{
  "skillSources": [{"name":"personal","path":"./my-skills"}],
  "mcpServers": [{"name":"notes","url":"http://127.0.0.1:8080/mcp","timeoutMs":10000}],
  "executionTool": false
}
```

MCP 支持 Streamable HTTP 或 stdio，url/command 二选一；支持 headers 或 env/args。来源名不得重复或复用 local/memory/tinyfish。连接失败使启动失败并清理已建立连接。关闭 Host 时释放连接。

主对话提供 task_control 和 Akasha memory_search/memory_read。Task Session 提供受目录约束的 read/write/edit，配置 executionTool:true 后增加 bash；MCP 调用均请求具体动作确认。TinyFish key 配置后提供查询工具，不提供浏览器操控。

Skills 由 Pi 原生资源加载，技能指令不扩大 Host 授权；工具输出、网页和 skill 文本不作为新的用户授权。MCP 与 bash 不做语义安全推断，按确切目标/参数/内容持久批准。当前没有旧通用 skill 安装与延迟发现平台。
