# 离线上下文诊断

## 单次运行失败

检查截图中的失败或模型调用中断，先按 Run 查询：

```powershell
npm run run:diagnose -- --run-id "待排查Run" --data-dir data
```

命令只读 `runtime-v2.sqlite` 中该 Run 的事实，不加载 `.env`、启动 Bot、调用模型、读取工具归档或写缓存。输出终止状态、工具结果与错误计数、最近一次上下文预算，以及每次模型调用的停止原因、HTTP 状态、服务端 request ID、耗时和脱敏错误分类。不会输出对话、工具参数/结果、请求正文、认证头、异常 message/stack 或 socket 数据。

新增 `model_transport` 事实通过 Provider 的响应回调和 Node/Undici 诊断通道记录；错误 cause 仅保留已知名称与错误码。缺失的信息显示 `null` 或空列表，旧记录不会被补写。未使用 Undici 的传输可能没有 cause；这些信息用于定位，不能单独证明具体网络节点故障。摘要调用也关联自己的 call ID。

新调用还记录以下结构化证据，计时均相对本次模型调用开始：

- `headersMs`：响应头到达；HTTP 200 不代表流已完成。
- `firstStreamEventMs`：消费到首个 SDK 事件；`start` 可能只是 SDK 初始化，不等于服务端首 token。
- `firstPublicTextMs`：首个非空 `text_delta`；thinking 和工具参数不算公开正文。
- `terminalEventMs` / `normalTerminal`：收到 SDK 终态的时间，以及是否为 `done`。这不是独立的服务端协议终态证明；`error` 的值为 false。
- `abortSource` / `abortMs`：调用期间首次观察到取消信号的来源和时间。来源是 `run-signal`、`provider-signal` 或 reason 为标准 `TimeoutError` 的 `timeout-signal`；`none` 表示未观察到外部信号，不能据此排除 SDK 内部取消。
- `runSignalAborted` / `providerSignalAborted`：记录时信号状态。运行取消同步传递给 Provider 时，归为运行信号。
- `configuredTimeoutMs`：显式传入的 SDK 超时配置；缺失不代表没有 SDK 默认超时，也不能用耗时反推超时触发。

启动、流迭代或结果读取直接抛错也记录一次诊断。SDK 已转成字符串的异常无法恢复原始名称或错误码；保留 unknown，不根据 `AbortError` 猜测网络节点。旧 Run 的这些字段为 null。

Telegram Bot 启动时固定 `runtime_identity`，每个新 Run 都记录同一身份，诊断输出 `runtimeIdentity`。源码模式记录启动时 HEAD 和 trackedDirty；编译模式读取 `npm run build` 生成的构建戳，不使用当前 checkout HEAD 冒充旧构建。trackedDirty 只覆盖已跟踪文件，不是整个运行环境或未跟踪源码的完整哈希；缺失构建戳报告 unknown。已运行的旧进程不会因拉取代码自动更新。

原生与兼容 Responses 的断流回归通过真实 Host → Agent → 本地 Provider：工具执行一次，客户端确认收到草稿后断开连接；本轮失败，不结算草稿，也不重跑已执行工具。自动重试策略保持现状。

## 上下文范围

排查历史恢复、压缩等待或上下文范围时，先核对 [ADR-0003](adr/0003-recent-turn-context.md)，再运行：

```powershell
npm run context:diagnose -- --conversation-id "telegram:private:你的ID"
npm run context:diagnose -- --conversation-id "你的Conversation" --request-id "待排查Run" --context-window 128000 --data-dir data
```

默认选择指定 Conversation 最新用户轮次。指定旧 Run 时，在下次用户输入前截断事实，避免带入未来轮次。窗口参数按实际模型配置填写；默认 128000，输入预算比例为 0.86。本工具无需 API Key，不加载 `.env`，不启动 Bot，不调用模型。

输出只有计数与估算：`historicalTurns`、`selectedMessages`、`initialEstimatedTokens`、`budget`、`exceedsBudget`、`archiveRecoveries`、`simulatedSummaryCalls`。`recordedSummaryCalls` 和 `recordedExecutionStarted` 来自目标 Run 的已记录事实，可区分压缩等待和已经开始的执行。

模拟压缩使用固定摘要替身；模拟次数与 token 数不代表真实服务耗时或 usage。估算仅覆盖选定消息，不包含固定提示词、工具定义和本轮新 Akasha 检索内容；采用通用文本投影，不作为专属推理协议验收。

生产数据库以只读模式打开。归档只校验、读取；缺失或损坏时诊断失败，不修复文件。派生缓存和模拟检查点只写入系统临时目录，结束后清理。完整对话、归档正文和密钥不会进入诊断输出。

HTTP 集成测试使用 `test/fixtures/http-server.ts` 的 `createTestServer`：回调失败结束请求并在 teardown 报错；响应超过默认五秒也结束并报错。需要较慢模拟时显式传入超时，错误正文只输出固定消息，原始异常由测试 runner 报告。
