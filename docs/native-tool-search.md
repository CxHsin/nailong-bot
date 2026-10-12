# 原生工具搜索适配

2026-10-13，#167 / #169。保留 Pi 0.73.1 的 Agent loop 和 Session JSONL，在每个原生 Session 的公开 `agent.streamFn` 边界适配协议，不修改安装依赖，不全局替换 provider。

## 已实现

OpenAI Responses 客户端搜索使用 `tool_search_call` / `tool_search_output`。执行目录在 Session 启动时注册，deferred 工具不追加到常驻 `tools`；发现输出在历史对应位置加载定义。可选择服务端搜索，保留原生搜索块，核对返回定义与当前目录，不在本地重复搜索。

Anthropic 每次请求发送完整 deferred 目录。客户端发现使用标准 `tool_result` 中的 `tool_reference`；服务端搜索保留 `server_tool_use` 和 `tool_search_tool_result` 的位置，只有普通 `tool_use` 进入 Pi 本地派发。`pause_turn` 使用同一流的有限续请求，累计实际计量；每个已确认暂停页保存到 fsync 后原子替换的 `native-pause.json`，包括尚未被 Pi 首次 JSONL 刷盘的输入。重开 Session 只恢复当前存活锚点、相同模型身份和有效定义对应的页面；重置/遗忘清除暂停快照。

发现记录附在 Pi assistant / toolResult 消息中，保留版本、工作身份、模型身份、schema 指纹及原生顺序。派发从当前实际上下文确定有效发现，压缩摘要中的名称不构成发现，定义变化必须重新搜索；发现不替代授权。错误、中止及不完整 assistant 响应不能授予新的发现。服务端执行仅覆盖工具搜索，不宣称支持其他 hosted 动作。

传输使用直接依赖的 OpenAI / Anthropic SDK，保留 ModelRegistry 的凭据与请求头解析、Session 缓存身份、provider timeout、SDK 重试、AbortSignal、请求/响应回调和 token/cache 计量。每次实际 HTTP 尝试（含 SDK 重试及暂停续接）先检查预算。原生请求被端点拒绝时明确报告能力不可用，不改发普通工具目录假装成功。未启用原生的模型继续普通聊天；额外能力目录不会因此全部曝光。

## 接入接口

`PersonalPiOptions.capabilityCatalog(scope)` 返回当前 Session 可执行的 `NativeCapability[]`。scope 包含 `sessionId`、`conversationId` 和 `cwd`。每项提供 `tool`、可选 `definitionVersion` 及 `authorize(call)`；即使 schema 未变，显式版本变化也使原发现失效。已有工具自身的文件/MCP/动作检查仍生效。

`nativeSearch` 可配置 `mode`（默认 client）、`maxPauseContinuations`（默认 3）、`maxRequests`（默认 40）及 `maxTokens`（默认 200000，个人执行器 limits 可覆盖）。`beforeRequest` 提供实际 HTTP 次数并允许上层预算拒绝；`onUsage` 提供每个响应页的实际 token/cache/cost。上层持久工作预算仍应维护自身账本，不能把 Session 单输入预算视为完整全局/单项预算。

deferred 工具的 `beforeDispatch` / `afterDispatch` 提供工作范围、callId、工具名、参数及定义版本，可接入动作账本与回执。它们不自动记录 Host ActionDispatch，也不替代工具原有授权。before 回调失败则无派发；实际执行失败产生 failed 回调；执行成功后的持久回执失败会保留异常，不能据此声称动作未发生。常驻工具原有授权路径继续使用，#170 / #171 按其具体副作用接入统一账本。

## 验证证据

协议测试通过 Host.submit、真实 Pi loop、临时 HTTP 协议服务器及实际纯工具效果核对两种客户端发现、服务端块顺序与零本地搜索、重开、Pi 实际压缩、模型切换、版本变化、越权拒绝、重复/部分/断流响应、429 重试和调用预算。Anthropic 暂停恢复用真实子进程在 fsync 检查点后、第 2 次 HTTP 前退出 71，再启动 Host，验证首次 assistant 尚未刷盘也能续接且纯工具只执行一次。

2026-10-13 对已配置代理 `gpt-6.1-sol` / OpenAI Responses 完成新适配器端到端探测：Host 输入 → 原生发现 → `probe_sum(2,3)` 实际纯工具执行 → 本体输出 5；3 次 HTTP、工具执行 1 次。三次 input tokens 分别 4918、5114、158，output tokens 为 41、23、5，第三次 cacheRead 为 4992。工具没有文件、网络或对外副作用；未修改 `.env`。临时证据脚本：`C:/Users/Cx/AppData/Local/Temp/nailong-native-adapter-live.mjs`。此路径属于本机临时证据，不是项目运行依赖。

Anthropic 当前未配置可用真实端点，仅协议夹具通过，真实端到端验收未完成。Telegram、完整执行权限后端以及父子委派的全局预算/回执闭环仍由对应后续阶段验证，本文不把这些认定为已完成。
