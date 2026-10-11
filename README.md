# Nailong bot

当前 Windows 电脑上的个人 Agent，通过 Telegram 私聊或 CLI 委托目标、补充要求、查询和停止任务。主对话与后台 Task 分开；互不冲突的任务可以并行，开发工作交给专用 herdr 会话中的 Codex，成果独立验收后交付。

规格为 [#157](https://github.com/CxHsin/nailong-bot/issues/157)，架构边界见 [ADR-0007](docs/adr/0007-personal-host-native-sessions.md)，迁移与验收见 [操作说明](docs/personal-agent-operations.md)。本轮不增加浏览器、通用桌面控制或稳定偏好画像。

## 使用

需要 Node.js 24+。执行 `npm install`，复制 `.env.example` 为 `.env` 并填写模型配置。Telegram 需要 `AGENT_TELEGRAM_BOT_TOKEN` 和 `AGENT_TELEGRAM_USER_ID`；旧 `TELEGRAM_*` 名称仍接受。新 checkout 执行 `npm run hooks:install`。

| 入口 | 命令 |
| --- | --- |
| Telegram | `npm start` |
| CLI 交互 | `npm run chat` |
| 单次输入 | `npm run send -- "整理文件并交付结果"` |
| 图片输入 | `npm run send -- "分析图片" --image photo.png` |
| 指定会话 | `npm run send -- "继续" --conversation-id telegram:private:42` |
| 机器可读交付 | `npm run send -- "问题" --ndjson` |

直接说明目标、目录和限制，或回复任务消息补充要求、查询、停止。关联不明确先澄清；回复关联优先于模型猜测。停止保留已有影响，未知执行仍占用资源。普通退出保留任务，重启核对实际执行者，未知效果不盲目重做。

| 命令 | 行为 |
| --- | --- |
| `/help` | 使用说明 |
| `/model`、`/model 别名` | 查看或切换主对话模型 |
| `/reset` | 作废主对话 Session，保留任务和记忆 |
| `/memory 关键词` | 检索 Akasha 原始来源 |
| `/forget 节点引用` | 排除来源并作废此会话上下文；保守停止旧任务、暂停计划，未知停止仍需核实 |

Telegram 使用普通消息和文件；长文分段，不显示流式草稿、工具过程或等待计时。未知送达不自动重发，用户确认重新交付只复用成果，不重做任务。

`AGENT_DATA_DIR` 默认 `data`，`AGENT_PROMPT_FILE` 默认 `system-prompt.md`。同一实际目录只允许一个 Host，CLI 不控制另一个进程中的 Telegram。跨入口续聊先停前一进程，并使用相同 conversationId 和 actorId；CLI actor 默认 `cli`，用 `AGENT_ACTOR_ID` 指定，Telegram actor 为 `telegram:<数字 ID>`。

## 责任与能力

Host 直接保存 Task/Attempt、输入、授权、计划和 Delivery；Pi 原生 Session 保存模型交换和 compaction。Akasha 专注原话检索、图关联、遗忘及送达后学习，不在工具循环重放历史，不生成稳定偏好档案。

文件任务限指定工作目录，保护运行数据、链接和硬链接。Skills 作为 Pi 原生资源加载，MCP 直接连接，见 [能力配置](docs/capabilities.md)。Shell/MCP 当前按确切目标、参数和内容确认并持久消费批准，任务要求变化使旧批准失效。会话结束不能证明外部动作已停止，无法核实时保持未知占用。

`AGENT_HERDR_SESSION` 必须指定专用具名会话；`AGENT_HERDR_KIND=codex` 使用 workspace-write/on-request。Claude 缺少 verified policy 时拒绝启动。Host 读取真实成果并检查，idle/done 不算成功。外部网络行为仍依赖执行器可落实的权限边界。

计划只接受用户明确要求，包含目标、时间或前置任务、时区和 missed skip/run/ask 策略。支持查询、修改、暂停、恢复、取消。触发消费与创建 Task 同一事务，重启不重复触发。服务停机期间不执行，重启按错过策略处理。

可配置 `AGENT_VERIFICATION_CHECKS` 为 JSON 数组，例如 `[{"command":"node","args":["--test"],"cwd":"D:/Code/example"}]`。这些是部署者预先授权的确切验收命令，只匹配相应工作目录。非零退出、超时或停止未知不能通过。

## 数据与验证

| 文件/目录 | 职责 |
| --- | --- |
| `personal.sqlite` | Task/Attempt、收件箱、去重、计划、授权和交付 |
| `host-owner.sqlite` | 进程独占锁 |
| `personal-sessions/` | Pi 原生主对话/任务 Session |
| `retired-sessions/` | reset/forget 后保留的旧 Session |
| `personal-memory.sqlite` | 记忆来源及学习事实 |
| `personal-artifacts/` | 验收成果副本与 SHA256 |
| `personal-history-backups/`、`personal-history-migration.json` | 历史导入备份和身份清单 |

首次启动只读旧 SQLite/JSONL，备份校验后离线导入 Session；旧委托不自动执行。源变化、坏边界或归档缺失会拒绝导入。原始源不重写，旧日志/投影/编码只用于迁移与诊断；本轮不修历史坏边界 #151。

`src/personal/` 为当前生产实现，Telegram/CLI 共享 runtime 工厂。旧全局 Run 队列、流式投影和自建在线上下文循环已退役。执行 `npm run typecheck`、`npm test`、`npm run build`、`npm run docs:check`。当前入口回归为 `test/personal-*.test.ts` 和实际 CLI 子进程测试。

真实 Windows/herdr 已验证文件验收、进程树停止与同身份崩溃恢复；真实 Telegram 凭据闭环仍待执行，受控 API 测试不能替代。详细覆盖、配置及回退边界见 [操作说明](docs/personal-agent-operations.md)。
