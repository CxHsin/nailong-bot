# Telegram 流式展示实机验收

本入口测试展示链路，使用固定内容，不调用模型、不启动 polling、不写聊天历史数据库。它复用生产 grammY Rich API adapter、Host projection 和 Markdown 分页；模型公开阶段的行为由 Provider 集成测试验证。

## 预览

```powershell
npm run telegram:accept
npm run telegram:accept -- --help
```

默认只输出固定内容与当前进程身份，不访问 Telegram API。`npm` 命令会加载 `.env`，但不会打印凭据。

## 发送到 owner 私聊

确认客户端已打开与 Bot 的私聊，并配置 `AGENT_TELEGRAM_BOT_TOKEN`、`AGENT_TELEGRAM_USER_ID`。显式指定 owner ID 才发送：

```powershell
npm run telegram:accept -- --send --chat-id 你的OWNER_ID
```

其他私聊目标会被拒绝。约十余秒内依次展示准备状态、公开进展结论和最终正文追加，然后保存进展与分页答案。命令会留下正式测试消息，需在 Telegram 手动清理；不会自动删除已有消息。测试与运行中的 Bot 各自占用 API 配额，遇到限流可稍后重试。

编译版验收使用构建戳：

```powershell
npm run build
node --env-file-if-exists=.env dist/src/cli/accept-telegram.js --send --chat-id 你的OWNER_ID
```

输出包含构建身份、Run ID、成功草稿的分段/长度/ID、正式消息 ID 和脱敏回执；不打印 token、异常原文或完整 API 对象。发送失败会返回已有回执与 `apiAcceptance: incomplete`，退出码非零。API 判定要求进展和最终正文分别在同一草稿 ID 上出现追加，且状态、进展和所有最终分页都成功保存。

构建只有在 TypeScript 检查成功后才输出文件并更新构建戳；检查失败保留上一份构建及其身份。

## 视觉验收

API 接受请求无法证明客户端动画与排版。报告始终保留 `visualAcceptance: pending`，在客户端逐项检查后，由人记录客户端版本、运行身份、时间与结果：

1. 准备状态出现，随后进展文字持续追加。
2. 进展结论保存后，最终正文继续追加。
3. 草稿到正式消息的加粗、斜体、标题、链接、引用、表格排版一致。
4. 长代码块跨页保持代码块与列表缩进，最后一页包含“验收结束标记”。

若排查实际 Bot 的截图，另用 `run:diagnose` 核对该 Run 的 `runtimeIdentity`；独立验收命令的身份不证明后台 Bot 已加载同一版本。旧进程需重新启动才会记录新增字段。
