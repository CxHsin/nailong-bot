# 个人 Telegram Agent

在本机运行的单人 Telegram 文字 Bot。使用 pi SDK 调用 DeepSeek，开放 pi 原生文件工具，并把 TinyFish MCP 的 `search`、`fetch_content` 映射为模型可选择的网页工具。

## 启动

需要 Node.js 24 或更新版本。

1. `npm install`
2. 复制 `.env.example` 为 `.env`，填写 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_USER_ID`、`DEEPSEEK_API_KEY`。需要网页搜索时再填写可选的 `TINYFISH_API_KEY`。用户 ID 是 Telegram 数字 ID，不是用户名。
3. 按需要编辑 `system-prompt.md`。
4. `npm start`

Bot 使用 long polling，无需公网地址。只响应配置的账号在私聊中发送的文字。电脑关机或进程停止时 Bot 不在线。`/reset` 开始新上下文，但不会删除旧记录。修改 System prompt 后重启生效。

## 运行事件与投影

`data/events.sqlite` 中按序追加的 Runtime Event Log 是运行事实源。用户消息、模型步骤与文字、工具派发与结果、Telegram 投递尝试与结果分别记录；已经生成的回答与已经送达的回答不是同一件事。运行时从同一份已提交日志生成不同视图：

- **Model Context Projection**（`src/projection.ts`、`src/context-budget.ts`）：重放用户、模型和工具历史，构造下一次模型调用。已定稿的进展文字会进入上下文；最终回答只有完整送达后才作为用户已收到的答复回放。
- **Telegram UI Projection**（`src/runtime-projections.ts`、`src/telegram-projection.ts`）：读取已提交的文字快照和投递状态。生成期间使用 Telegram 原生草稿显示选中的文字；定稿后发送持久消息，记录实际投递结果。长消息按 Telegram 限制分段。
- **运行与恢复视图**（`src/runtime-projections.ts`）：推导请求终态和重启后的待核对内容。重启时未结束的请求标为中断，不自动重做已经派发但结果未知的工具操作。

`src/runtime-projections.ts` 中的简化聊天视图仅服务于 `answer(messages)` 适配器；正式 pi 会话使用完整事件重放。`src/tool-result-projection.ts` 集中定义工具结果给模型的原文或归档引用视图，并在新事件中记录投影版本与当时的选择。投影和摘要都不改写原始运行事件。

`.env`、`data/` 和原有的 `tinyFish.txt` 都被 Git 忽略。启动时如发现旧版 `data/events.jsonl`，会校验并幂等导入 SQLite，旧文件保留。完整工具结果存于 `data/tool-results/`，历史摘要 checkpoint 存于 `data/checkpoints/`。这些数据可能包含私人文件内容和工具参数，请按私人数据管理。

每次模型调用前会估算上下文大小，默认输入预算为模型上下文窗口的 86%。可用 `PROJECTION_BUDGET_RATIOS` 按模型覆盖，例如 `{"deepseek/deepseek-flash":0.8}`。超预算时，较早的完整历史会折叠为经过来源校验的摘要，尽量保留最近三个完整请求；`/reset` 只改变续聊边界，不删除旧事件。

较大的工具结果会先完整归档，再把包含路径、大小和校验值的引用交给模型。模型可用 `read` 分段取回归档文本。归档失败时仍使用原始结果；日志写入失败则停止后续工具或模型步骤。工具已执行但结果未成功入库时，下一轮只标记结果未知，避免盲目重试。

## 本机文件工具

模型可自行调用 `read`、`write`、`edit`、`ls`、`find`、`grep`，完成文件读取、写入、修改、目录浏览和搜索。文件内容、命名、格式和组织方式由模型结合对话决定；`write` 可覆盖已有文件。没有开放 `bash` 命令执行工具。

默认笔记目录为 `D:\Course\Study\nailong notes`，在 `system-prompt.md` 中约定，可自行修改后重启。消息中也可指定其他路径。该约定不构成权限隔离，文件访问使用 Bot 进程的系统权限；相对路径按 pi 会话工作目录 `data/` 解析。

文件工具不依赖 TinyFish。没有配置 TinyFish 或连接失败时仍可使用；`find` 和 `grep` 使用 pi 管理的 fd／ripgrep，缺失时 pi 会尝试下载。

## 验证

`npm run typecheck`、`npm test`、`npm run build`。

配置真实凭据后，分别验证普通聊天、需要搜索的问题、包含网址的问题、流式草稿与最终消息、重启续聊，以及 `/reset` 后的新对话。再在普通对话中要求保存一个结论，检查回复涉及的文件是否实际存在、内容是否可读。TinyFish 不可用时 Bot 仍能进行普通聊天和文件操作，启动日志会说明网页查询工具未启用。Telegram 原生草稿的具体渐入效果由客户端呈现，自动化测试不能替代真实聊天中的视觉检查。


### Bot 提示词与输出协议

私聊中已授权用户可以使用 `/prompt` 查看 bot 提示词，`/prompt set 提示词` 设置当前聊天的提示词，`/prompt reset` 恢复默认。配置持久保存在运行事件日志中，从下一次请求生效；修改不会清空历史，`/reset` 仍用于新对话。

默认 bot 提示词来自 `system-prompt.md`。执行协议由程序维护，普通文件工具不能修改程序资源、默认提示词及受保护运行存储。每个请求固定提示词快照。模型文字使用 progress/final JSON 协议，用户只看到校验后的正文；纯进展继续运行，最终答复进入交付流程。协议错误最多纠正两次，连续三次纯进展且无工具调用会报告未完成。
