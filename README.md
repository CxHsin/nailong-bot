# Nailong bot

Windows 上的个人助手：一个 Telegram bot 对应一个原生 Pi 主 agent。Telegram 和 CLI 共用接入服务；Pi 负责会话、工具、压缩、steering 和 skills/扩展，编码通过 herdr-workflow 委派给 Codex 或 Claude Code，再由主助手检查成果。

当前规格 [#196](https://github.com/CxHsin/nailong-bot/issues/196)，实现任务 [#197](https://github.com/CxHsin/nailong-bot/issues/197)，架构见 [ADR-0010](docs/adr/0010-native-pi-assistant.md)。本轮证据与限制见 [验收记录](docs/pi-assistant-acceptance-20261014.md)。

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

支持 `/help`、`/model`、`/model 别名`、`/reset`。工作期间可以插话，原生 Pi steering 在下一次模型请求前呈现补充要求。编码帮手在后台工作，无关交流直接回应；指定帮手的补充要求和停止通过 skill 核对真实身份后执行。停止不能撤销已有影响，无法核实时如实报告。

Telegram 仅接收配置主人的私聊，支持文字、图片、Markdown 富消息、分页、临时正文预览和文件。格式被明确拒绝时回退文本；发送结果不明保留记录，不自动重发。细节见 [操作说明](docs/personal-agent-operations.md)。

## 数据与执行

`ASSISTANT_DATA_DIR` 默认 `data/pi-assistant-v1`，`ASSISTANT_WORK_DIR` 默认启动目录，`AGENT_PROMPT_FILE` 默认 `system-prompt.md`。会话重开沿用原工作目录。同一数据目录同时只允许一个进程；跨 CLI/Telegram 续聊须先停止前一进程。

使用独立干净数据目录，不读取、迁移或注入旧 Task、Akasha、计划及历史会话；旧文件不自动删除。Pi 会话位于 `sessions/`；接入层仅保存会话指针、输入去重、帮手身份与 Telegram 发送记录。`/reset` 新建 Pi 会话，保留历史文件和帮手观察；不会停止外部帮手。

文件与 Shell 继承启动账户权限，工作目录不是沙箱。用户和项目指令继续约束行动；发布、外发、重要删除及合并须有对应授权。主路径移除 Host 权限参数和通用成果结算表单。能力配置见 [能力说明](docs/capabilities.md)。主动能力、服务器、多 bot 和 Akasha 接入暂不实现。

## 验证

`src/assistant/` 为当前服务，正式入口是 `src/main.ts` 与 `src/cli/main.ts`。执行 `npm run typecheck`、`npm test`、`npm run build`、`npm run docs:check`；当前接入回归为 `test/assistant-*.test.ts`。历史实验保留当时证据，不代表新版保证；离线诊断命令仍只处理旧日志，不接入主助手。
