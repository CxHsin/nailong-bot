# 持久队列主助手操作说明

当前规格 [#201](https://github.com/CxHsin/nailong-bot/issues/201)，架构 [ADR-0011](adr/0011-durable-main-agent-and-conversation-queue.md)，验证状态见 [切换验收](durable-assistant-acceptance-20261015.md)。nailong 负责输入接收与会话调度，Pi Durable 1.2.0 保存主 agent 执行进度。

## Telegram 如何接入

沿用现有 BotFather token。填写 `.env` 的 `AGENT_TELEGRAM_BOT_TOKEN` 和 `AGENT_TELEGRAM_USER_ID`（也接受 `TELEGRAM_*`），配置主模型后运行 `npm start`。服务通过 grammY long polling 接收该主人的私聊，文字和图片进入同一个主会话。当前不支持群聊或多 bot。CLI 使用 `npm run chat` 或 `npm run send -- "内容"`，可加 `--conversation-id telegram:private:<owner id>` 指定会话。

只启动一个实例。若之前配置 webhook，须自行确认 polling 的使用方式；新版启动不会自动删除 webhook。先停止旧入口，再运行新版，避免两个进程消费同一 bot 的更新。旧 token 不必重新申请，旧数据也不会自动清除。

支持 Markdown 富消息、代码与表格、长文分页、临时正文草稿预览和 `send_file` 文件交付。只有明确的格式 400 拒绝才降级原文块；连接断开等未知结果写入 `telegram-sends.jsonl`，不自动重发。草稿是预览，不能证明最终消息已送达。文件发送错误返回模型；结果不明时先核对记录。

## 数据与会话

`ASSISTANT_DATA_DIR` 默认 `data/pi-durable-v1`。显式配置可覆盖，但须使用独立新执行空间；启动检查拒绝把旧 Session 目录当作新空间。不要把它指向 `data/pi-assistant-v1` 或旧 Host 目录。配置、模型端点与凭据接入继续沿用，不导入旧历史、摘要、工具轨迹、Akasha 或 Task，不删除旧目录或成果。

新空间分别保存完整输入与固定批次、主执行记录、会话控制与帮手材料，以及通道发送回执。已有外部 herdr 委派须保留并核对真实身份，不能因新会话没有历史就重新派发。工作目录由 `ASSISTANT_WORK_DIR` 指定，默认启动目录，重开会话沿用原目录；`AGENT_PROMPT_FILE` 默认 `system-prompt.md`，`AGENT_SHELL_PATH` 可指定 shell。工作目录与执行数据空间各自独立。

`ASSISTANT_LEGACY_DATA_DIR` 默认 `data/pi-assistant-v1`，只读查找旧会话中的 helper 身份并登记到新空间，不导入对话历史，也不修改旧目录。旧记录损坏时先修正记录再启动。

新目录中，`queue.sqlite` 保存事件、批次及内部结果，`queue-owner.sqlite` 用于单服务独占，`assistant.sqlite` 保存会话控制、帮手身份和输出交付记录；各会话的 Durable 步骤位于 `executions/<会话标识的 SHA-256>/session.sqlite`，Telegram 发送回执位于 `telegram-sends.jsonl`。备份时停止服务并保留整个数据目录。

同一数据目录的 Telegram 与 CLI 不同时启动。`--full-access` 接受为可信执行声明，`--restricted` 拒绝，因为新版没有受限执行后端。

## 队列与命令

输入确认接收前保存来源身份、会话、正文、图片材料和顺序。重复投递的同一源消息去重；正文相同但身份不同仍是两条输入。每个会话一次执行一个主 agent 处理轮次，其他会话可分别推进。

普通直接输入同级 FIFO，不改动正在处理的直接输入。当前轮结束或空闲时，按原顺序领取已排队普通消息的有限连续前缀；不等待凑批时间窗，命令、不同来源或不同优先级隔开批次。每条消息保留身份和边界，批次可以统一回复，轮次结束不表示每个业务目标都已完成。

| 命令 | 行为 |
| --- | --- |
| `/help` | 显示用法 |
| `/model`、`/model 别名` | 查看或切换主模型；外部 Codex/Claude 模型不随之改变 |
| `/steer 内容` | 显式补充当前工作，在执行器支持的输入边界按序读取；不立即中止正在运行的工具 |
| 空闲时 `/steer 内容` | 正文作为普通输入入队，遵守已有顺序 |
| 空的 `/steer` | 只显示用法 |
| `/resume [批次ID]` | 明确继续本会话暂停的工作；省略 ID 时继续本会话全部暂停项 |
| `/reset` | 清主上下文，保留已接收事件、执行进度和帮手身份；不取消工作、不停止外部进程 |

只有显式 `/steer` 补充当前工作，连续补充保留各自身份。若模型已经最终答复，补充可能在后续 run 执行。直接用户输入高于后台事件，可抢占低优先级轮次；旧工作保存成果，之后由主 agent 结合最新指令核对继续、调整或结束。

## 编码与恢复

herdr-workflow 负责派发、确认接收、转交要求、停止和独立成果核对；`herdr_watch` 只登记并观察已派发帮手。主 agent 可结束派发轮次并接收后续输入，helper 在独立上下文中执行，不把全部中间操作填进主会话。

回传先作为内部材料持久保存；当前轮结束后先处理已经排队的直接用户输入，再交给主 agent。它不进入普通用户消息队列，也不因回传本身直接发送 Telegram。主 agent 核查实际文件、差异与命令结果，不能把 idle/done 当作成果验收。重启查询原 herdr 身份与状态，不盲目启动替代任务。

意外退出后重开同一新空间，恢复已接收输入、原批次和已提交执行。已确认模型/工具结果复用，不通过重跑整个轮次重试单次请求。模型临时故障仅由执行器重试：最多 3 次，含首次共 4 次请求，基础等待 2 秒；底层 provider 不叠加重试。

重试耗尽后保留进度、暂停并通知一次，等待明确继续，其他输入仍可处理。重启保持主动暂停或待核实状态。工具与业务错误交回模型判断，不机械重试任意 Shell。外部操作结果不明时先核实：确认完成则采用结果，确认未执行才执行，无法确认则暂停询问。停止、抢占、重置都不能撤销已有影响。

cron、邮件、Slack、完整分层记忆、herdr 内部步骤恢复和服务器部署不在本次范围。`run:diagnose`、`context:diagnose` 和旧 `migrate` 为旧日志离线工具，不能用于恢复新版执行。历史验收只适用于其记录的基准，进程强杀证据不能推导断电持久性或跨系统 exactly-once。
