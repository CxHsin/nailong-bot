# 原生 Pi 主助手操作说明

当前规格 [#196](https://github.com/CxHsin/nailong-bot/issues/196)，架构 [ADR-0010](adr/0010-native-pi-assistant.md)，验证 [本轮记录](pi-assistant-acceptance-20261014.md)。

## Telegram 如何接入

沿用现有 BotFather token。填写 `.env` 的 `AGENT_TELEGRAM_BOT_TOKEN` 和 `AGENT_TELEGRAM_USER_ID`（也接受 `TELEGRAM_*`），配置主模型后运行 `npm start`。服务通过 grammY long polling 接收该主人的私聊，文字和图片进入同一个 Pi 主 Session。当前不支持群聊或多 bot。启动设置该主人可见的 `/help`、`/reset`、`/model` 菜单。

只启动一个实例。若之前配置 webhook，须自行确认 polling 的使用方式；新版启动不会自动删除 webhook。先停止旧入口，再运行新版，避免两个进程消费同一 bot 的更新。旧 token 不必重新申请，旧数据也不会自动清除。

支持 Markdown 富消息、代码与表格、长文分页、临时正文草稿预览和 `send_file` 文件交付。只有明确的格式 400 拒绝才降级原文块；连接断开等未知结果写入 `telegram-sends.jsonl`，不自动重发。草稿是预览，不能证明最终消息已送达。文件发送错误返回模型；结果不明时先核对记录。

## 数据与会话

`ASSISTANT_DATA_DIR` 默认 `data/pi-assistant-v1`。不要把它指向旧 Host 的数据目录；新版不运行任何旧迁移、不加载 Akasha 和计划、不删除旧文件。`ASSISTANT_WORK_DIR` 默认启动目录，`AGENT_PROMPT_FILE` 默认 `system-prompt.md`；`AGENT_SHELL_PATH` 可指定 Pi 的 shell。

| 内容 | 用途 |
| --- | --- |
| `owner.sqlite` | 独占事务锁，进程退出自动释放 |
| `conversations.json` | version 1：会话身份、原工作目录 |
| `sessions/<hash>/*.jsonl` | 原生 Pi 会话 |
| `sessions/<hash>/session.json` | version 1：当前会话指针 |
| `sessions/<hash>/inputs.json` | 已接受输入去重 |
| `sessions/<hash>/helpers.json` | version 1：已派发帮手观察记录 |
| `telegram-sends.jsonl` | 发送/拒绝/未知结果 |

`/reset` 新建主 Session，保留历史文件和帮手观察记录，不终止外部进程。`/model 别名` 切换主模型；外部 CLI 保持自己的设置。CLI 默认按启动目录与 actor 选择会话，也可用 `--conversation-id`；同一数据目录的 Telegram 与 CLI 不同时启动。`--full-access` 接受为可信执行声明，`--restricted` 拒绝，因为新版没有受限执行后端。

## 编码与恢复

herdr-workflow 负责派发、确认接收、转交要求、停止和独立成果核对；`herdr_watch` 让主助手及时返回对话。回传属于外部材料，主助手先检查实际文件/差异/检查结果，再继续目标，不能把 idle/done 当成果验收。

重启读取已知会话和帮手记录，输出通道挂接后查询真实 herdr 身份与状态，不重复启动。已写入原生 Session 的回传有去重回执；仅排队而未持久呈现的回传会重新核对。重启不是自动完成所有工作的承诺。输入去重先于模型执行，崩溃时未完成输入可能需要用户核对后重新交办。停止不撤销已有影响，无法验证进程停止就报告未知。

主动职责、定时任务、服务器部署、多 bot 与旧数据迁移暂不实现。`run:diagnose`、`context:diagnose` 和 `migrate` 保留为旧日志的离线工具，不能用来恢复新版主助手。历史验收只适用于其记录的基准。
