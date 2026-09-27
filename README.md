# 个人 Telegram Agent

在本机运行的单人 Telegram 文字 Bot。使用 pi SDK 调用 DeepSeek，并把 TinyFish MCP 的 `search`、`fetch_content` 映射为模型可选择的网页工具。

## 启动

需要 Node.js 24 或更新版本。

1. `npm install`
2. 复制 `.env.example` 为 `.env`，填写 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_USER_ID`、`DEEPSEEK_API_KEY`、`TINYFISH_API_KEY`。用户 ID 是 Telegram 数字 ID，不是用户名。
3. 按需要编辑 `system-prompt.md`。
4. `npm start`

Bot 使用 long polling，无需公网地址。只响应配置的账号在私聊中发送的文字。电脑关机或进程停止时 Bot 不在线。`/reset` 开始新上下文，但不会删除旧记录。修改 System prompt 后重启生效。

`.env`、`data/` 和原有的 `tinyFish.txt` 都被 Git 忽略。`data/events.jsonl` 是唯一的持久聊天记录；每次调用 pi 时从当前会话的近期记录构建上下文，最多 60,000 个字符，旧记录完整保留。请把这些文件视为私人数据。

## 验证

`npm run typecheck`、`npm test`、`npm run build`。

配置真实凭据后，分别验证普通聊天、需要搜索的问题、包含网址的问题、重启续聊，以及 `/reset` 后的新对话。TinyFish 不可用时 Bot 仍能进行普通聊天，启动日志会说明网页查询工具未启用。
