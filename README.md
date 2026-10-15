# Nailong bot

Windows 上的个人助手：一个 Telegram bot 对应一个主 agent。Telegram 和 CLI 共用持久接入服务；nailong 队列负责接收、去重、会话路由、优先级和合批，Pi Durable 1.2.0 保存模型与工具执行进度。编码通过 herdr-workflow 委派给 Codex 或 Claude Code，再由主助手检查成果。

当前规格 [#201](https://github.com/CxHsin/nailong-bot/issues/201)，实现任务 [#202](https://github.com/CxHsin/nailong-bot/issues/202)、[#203](https://github.com/CxHsin/nailong-bot/issues/203)、[#204](https://github.com/CxHsin/nailong-bot/issues/204)、[#205](https://github.com/CxHsin/nailong-bot/issues/205)，架构见 [ADR-0011](docs/adr/0011-durable-main-agent-and-conversation-queue.md)。切换验证状态与限制见 [验收记录](docs/durable-assistant-acceptance-20261015.md)。

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

支持 `/help`、`/model`、`/model 别名`、`/reset`、`/steer 内容`、`/resume [批次ID]`。普通新消息按同级 FIFO 排队；当前轮结束后，将已经排队的连续普通消息按原顺序交给下一轮，不等待固定时间窗。仅显式 `/steer` 补充当前工作；空闲时其正文作为普通消息入队。后台工作优先级低于直接输入，外部帮手的补充要求与停止通过 skill 核对真实身份后执行。

Telegram 仅接收配置主人的私聊，支持文字、图片、Markdown 富消息、分页、临时正文预览和文件。格式被明确拒绝时回退文本；发送结果不明保留记录，不自动重发。细节见 [操作说明](docs/personal-agent-operations.md)。

## 数据与执行

`ASSISTANT_DATA_DIR` 默认 `data/pi-durable-v1`，`ASSISTANT_WORK_DIR` 默认启动目录，`AGENT_PROMPT_FILE` 默认 `system-prompt.md`。会话重开沿用原工作目录。同一数据目录同时只允许一个进程；跨 CLI/Telegram 续聊须先停止前一进程。

使用独立执行数据空间，不导入旧会话历史、摘要、工具轨迹、Task 或 Akasha，旧文件不自动删除。切换前先停止旧入口；配置与凭据继续使用，已派发帮手按真实身份核对。接收确认前保存完整输入与材料，意外重启续接已保存的批次和执行进度；明确暂停的工作需 `/resume` 继续。`/reset` 清理主上下文，保留排队输入、进度与委派，不等于取消工作。

临时模型故障最多重试 3 次（含首次共 4 次），基础等待 2 秒，仅执行器负责重试。耗尽后保留进度并暂停，其他输入仍可处理。未知外部效果先核实，无法确认时暂停询问；停止、抢占和重置不会回滚已有影响。

文件与 Shell 继承启动账户权限，工作目录不是沙箱。用户和项目指令继续约束行动；发布、外发、重要删除及合并须有对应授权。主路径移除 Host 权限参数和通用成果结算表单。能力配置见 [能力说明](docs/capabilities.md)。主动能力、服务器、多 bot 和 Akasha 接入暂不实现。

## 验证

`src/assistant/` 为当前服务，正式入口是 `src/main.ts` 与 `src/cli/main.ts`。执行 `npm run typecheck`、`npm test`、`npm run build`、`npm run docs:check`；当前接入回归为 `test/assistant-*.test.ts`。历史实验保留当时证据，不代表新版保证；离线诊断命令仍只处理旧日志，不接入主助手。
