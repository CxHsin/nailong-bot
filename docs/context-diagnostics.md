# 离线上下文诊断

## 单次运行失败

检查截图中的失败或模型调用中断，先按 Run 查询：

```powershell
npm run run:diagnose -- --run-id "待排查Run" --data-dir data
```

命令只读 `runtime-v2.sqlite` 中该 Run 的事实，不加载 `.env`、启动 Bot、调用模型、读取工具归档或写缓存。输出终止状态、工具结果与错误计数、最近一次上下文预算，以及每次模型调用的停止原因、HTTP 状态、服务端 request ID、耗时和脱敏错误分类。不会输出对话、工具参数/结果、请求正文、认证头、异常 message/stack 或 socket 数据。

新增 `model_transport` 事实通过 Provider 的响应回调和 Node/Undici 诊断通道记录；错误 cause 仅保留已知名称与错误码。缺失的信息显示 `null` 或空列表，旧记录不会被补写。未使用 Undici 的传输可能没有 cause；这些信息用于定位，不能单独证明具体网络节点故障。摘要调用也关联自己的 call ID。

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
