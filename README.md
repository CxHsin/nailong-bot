# 个人 Telegram Agent

在本机运行的单人 Telegram 文字 Bot。使用 pi SDK 调用 DeepSeek，开放 pi 原生文件工具，并把 TinyFish MCP 的 `search`、`fetch_content` 映射为模型可选择的网页工具。

## 启动

需要 Node.js 24 或更新版本。

1. `npm install`
2. 复制 `.env.example` 为 `.env`，填写 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_USER_ID`、`DEEPSEEK_API_KEY`、`TINYFISH_API_KEY`。用户 ID 是 Telegram 数字 ID，不是用户名。
3. 按需要编辑 `system-prompt.md`。
4. `npm start`

Bot 使用 long polling，无需公网地址。只响应配置的账号在私聊中发送的文字。电脑关机或进程停止时 Bot 不在线。`/reset` 开始新上下文，但不会删除旧记录。修改 System prompt 后重启生效。

`.env`、`data/` 和原有的 `tinyFish.txt` 都被 Git 忽略。`data/events.jsonl` 追加保存聊天及运行事件；完整工具结果保存在 `data/tool-results/`。这些记录可能包含私人文件内容和工具参数，请按私人数据管理。每次调用 pi 时仍从当前会话的近期已送达聊天记录构建上下文，最多 60,000 个字符；`/reset` 不删除旧事件。

同一轮中，较大的工具结果会先完整归档，再以包含路径、大小和校验值的短提示交给模型。模型可用现有 `read` 工具按段读取归档的文本视图。归档失败时原结果仍交给模型，并完整写入运行事件。运行事件写入失败会停止后续工具或模型步骤；已执行但结果未入库的工具不会自动重试。模型已生成的回答与 Telegram 送达状态分开记录，未送达的回答可在事件中查到，但不进入续聊历史。跨轮工具结果投影和可见进度尚未加入。

## 本机文件工具

模型可自行调用 `read`、`write`、`edit`、`ls`、`find`、`grep`，完成文件读取、写入、修改、目录浏览和搜索。文件内容、命名、格式和组织方式由模型结合对话决定；`write` 可覆盖已有文件。没有开放 `bash` 命令执行工具。

默认笔记目录为 `D:\Course\Study\nailong notes`，在 `system-prompt.md` 中约定，可自行修改后重启。消息中也可指定其他路径。该约定不构成权限隔离，文件访问使用 Bot 进程的系统权限；相对路径按 pi 会话工作目录 `data/` 解析。

文件工具不依赖 TinyFish。没有配置 TinyFish 或连接失败时仍可使用；`find` 和 `grep` 使用 pi 管理的 fd／ripgrep，缺失时 pi 会尝试下载。

## 验证

`npm run typecheck`、`npm test`、`npm run build`。

配置真实凭据后，分别验证普通聊天、需要搜索的问题、包含网址的问题、重启续聊，以及 `/reset` 后的新对话。再在普通对话中要求保存一个结论，检查回复涉及的文件是否实际存在、内容是否可读。TinyFish 不可用时 Bot 仍能进行普通聊天和文件操作，启动日志会说明网页查询工具未启用。
