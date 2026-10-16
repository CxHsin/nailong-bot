# Nailong bot

Windows 上的个人助手：一个 Telegram bot 对应一个主 agent。Telegram 和 CLI 共用持久接入服务；nailong 队列负责接收、去重、会话路由、优先级和合批，Pi Durable 1.2.0 保存模型与工具执行进度。编码通过 herdr-workflow 委派给 Codex 或 Claude Code，再由主助手检查成果。

持久执行规格为 [#201](https://github.com/CxHsin/nailong-bot/issues/201)，上下文输入路由规格为 [#215](https://github.com/CxHsin/nailong-bot/issues/215)。架构见 [ADR-0011](docs/adr/0011-durable-main-agent-and-conversation-queue.md) 与 [ADR-0013](docs/adr/0013-contextual-input-routing.md)，验证状态见 [路由验收记录](docs/contextual-input-routing-acceptance-20261016.md)。

## 使用

需要 Node.js 24+。执行 `npm install`，复制 `.env.example` 为 `.env`，填写模型配置。新 checkout 执行 `npm run hooks:install`。Telegram 填写 `AGENT_TELEGRAM_BOT_TOKEN` 与 `AGENT_TELEGRAM_USER_ID`，也接受旧 `TELEGRAM_*` 名称。

| 入口 | 命令 |
| --- | --- |
| Telegram 主助手 | `npm start` |
| CLI 交互 | `npm run chat` |
| 单次输入 | `npm run send -- "整理文件并交付结果"` |
| 图片 | `npm run send -- "分析图片" --image photo.png` |
| 续接指定会话 | `npm run send -- "继续" --conversation-id telegram:private:42` |
| JSON 输出 | `npm run send -- "问题" --ndjson` |

支持 `/help`、`/model`、`/model 别名`、`/reset`、`/resume [批次ID]`。直接用自然语言交办、补充或取消工作；独立请求按 FIFO 排队，排队目标的补充保留原位置，当前工作的补充在执行器输入边界读取。显式取消保留已有成果，实际停止需核实。分类模型通过 `ASSISTANT_INTENT_MODEL` 独立选择；未配置或判断失败时，原输入交给主助手处理。旧 `/steer` 命令提示改用自然语言。

Telegram 仅接收配置主人的私聊，支持文字、图片、Markdown 富消息、分页、临时正文预览和文件。格式被明确拒绝时回退文本；发送结果不明保留记录，不自动重发。细节见 [操作说明](docs/personal-agent-operations.md)。

## 数据与执行

`ASSISTANT_DATA_DIR` 默认 `data/pi-durable-v1`，`ASSISTANT_WORK_DIR` 默认启动目录，`AGENT_PROMPT_FILE` 默认 `system-prompt.md`。会话重开沿用原工作目录。同一数据目录同时只允许一个进程；跨 CLI/Telegram 续聊须先停止前一进程。

使用独立执行数据空间，不导入旧会话历史、摘要、工具轨迹、Task 或 Akasha。旧实现、离线工具及 helper 导入按 [ADR-0014](docs/adr/0014-retire-legacy-code-and-data.md)退役，遗留数据由一次性维护清理，启动不自动删除资料。现役 helper 按已登记的真实身份接回。接收确认前保存完整输入与材料，意外重启续接已保存的批次和执行进度；明确暂停的工作需 `/resume` 继续。`/reset` 清理主上下文，保留排队输入、进度与委派，不等于取消工作。

临时模型故障最多重试 3 次（含首次共 4 次），基础等待 2 秒，仅执行器负责重试。耗尽后保留进度并暂停，其他输入仍可处理。未知外部效果先核实，无法确认时暂停询问；停止、抢占和重置不会回滚已有影响。

文件与 Shell 继承启动账户权限，工作目录不是沙箱。用户和项目指令继续约束行动；发布、外发、重要删除及合并须有对应授权。主路径移除 Host 权限参数和通用成果结算表单。能力配置见 [能力说明](docs/capabilities.md)。共享长期记忆和 Akasha 原文召回遵循 [ADR-0012](docs/adr/0012-layered-memory-and-stable-context.md)；主动连接器、服务器和多 bot 仍在范围外。

## 验证

`src/assistant/` 为当前服务，正式入口是 `src/main.ts` 与 `src/cli/main.ts`。执行 `npm run typecheck`、`npm test`、`npm run build`、`npm run docs:check`；当前接入回归为 `test/assistant-*.test.ts`。旧日志诊断与迁移命令已退役；历史实验保留当时证据，不代表新版保证。
