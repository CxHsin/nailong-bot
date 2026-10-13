# Nailong bot

当前 Windows 电脑上的个人 Agent，通过 Telegram 私聊或 CLI 持续共事。本体直接处理轻量工作，研究、整理和编码交给独立帮手；材料回到本体复查并继续完整目标。用户可以插话、补充要求和停止整项工作或指定帮手。

当前底座规格为 [#189](https://github.com/CxHsin/nailong-bot/issues/189)，架构边界见 [ADR-0009](docs/adr/0009-runtime-work-context.md)与 [ADR-0008](docs/adr/0008-personal-agent-orchestration-direction.md)，迁移见 [操作说明](docs/personal-agent-operations.md)，#167 的历史证据与未验证项见 [原验收](docs/personal-agent-acceptance-20261013.md)。

## 使用

需要 Node.js 24+。执行 `npm install`，复制 `.env.example` 为 `.env` 并填写模型配置。Telegram 需要 `AGENT_TELEGRAM_BOT_TOKEN` 和 `AGENT_TELEGRAM_USER_ID`；旧 `TELEGRAM_*` 名称仍接受。新 checkout 执行 `npm run hooks:install`。

| 入口 | 命令 |
| --- | --- |
| Telegram | `npm start` |
| CLI 交互 | `npm run chat` |
| 主动受限交互 | `npm run chat -- --restricted` |
| 显式选择 full access | `npm run chat -- --full-access` |
| 单次输入 | `npm run send -- "整理文件并交付结果"` |
| 图片输入 | `npm run send -- "分析图片" --image photo.png` |
| 指定会话 | `npm run send -- "继续" --conversation-id telegram:private:42` |
| 机器可读交付 | `npm run send -- "问题" --ndjson` |

直接说明目标、目录和限制，或回复任务消息补充要求、查询、停止。关联不明确先澄清；回复关联优先于模型猜测。停止保留已有影响，未知执行仍占用资源。普通退出保留任务，重启核对实际执行者，未知效果不盲目重做。

| 命令 | 行为 |
| --- | --- |
| `/help` | 使用说明 |
| `/steer TaskID 补充要求` | 显式保存补充要求，在当前工具轮次结束后呈现；普通回复仍由模型判断意图 |
| `/model`、`/model 别名` | 查看或切换主对话模型 |
| `/reset` | 作废主对话 Session，保留任务和记忆 |
| `/memory 关键词` | 检索 Akasha 原始来源 |
| `/forget 节点引用` | 排除来源并作废此会话上下文；保守停止旧任务、暂停计划，未知停止仍需核实 |

Telegram 私聊使用 Markdown 富消息和文件，支持标题、粗体、代码与表格；当前用户回复的正文通过临时草稿流式预览，最终通过正式消息交付。长文按 Markdown 块分页，超大块或格式拒绝时降级为原文文本；后台工具过程不逐条推送。未知送达不自动重发，用户确认重新交付只复用成果，不重做任务。接口与验收边界见 [Telegram 输出说明](docs/personal-agent-operations.md#telegram-回复渲染与预览174)。

`AGENT_DATA_DIR` 默认 `data`，`AGENT_PROMPT_FILE` 默认 `system-prompt.md`。本地交互以启动目录建立新会话的工作目录，默认会话按项目区分；重开保存的会话使用原目录和模式。指定 `--conversation-id` 可续接原会话。两个模式标志互斥，仅用于 `chat`；`send`、Telegram 和计划不因此默认提权。

同一实际数据目录只允许一个 Host，CLI 不控制另一个进程中的 Telegram。跨入口续聊先停前一进程，并使用相同 conversationId 和 actorId；CLI actor 默认 `cli`，用 `AGENT_ACTOR_ID` 指定，Telegram actor 为 `telegram:<数字 ID>`。

## 责任与能力

Host 保存整体工作/子委派、Attempt、输入、事件回执、授权、计划和 Delivery；Pi 原生 Session 保存模型交换和 compaction。Akasha 在真实用户输入时自动召回一次相关原话，保留时间、角色与出处；工具续步和后台结果不新增自动召回。明确工作约定独立保存内容、作用域和撤销历史，当前要求优先，不生成稳定偏好档案。

本地交互默认 full access，文件与 Shell 使用启动账户的实际权限，工作目录是默认位置，不是沙箱；用户当前指令继续约束工作范围。主动受限模式及其他入口保留自己的授权，无满足边界的命令后端时返回错误。工具失败直接交给模型恢复或解释，不要求独立受阻报告表单。原生发现不授予执行权限。详见 [能力与工作权限](docs/capabilities.md)。

Runtime 关联实际呈现的要求，Host 核对版本，模型不填写内部版本号。普通回复结束不会自动将 Task 标成成功；整体完成仍要明确提出并核验必要成果。会话结束不能证明外部动作已停止，无法核实时保持未知占用。

编码委托由项目 [herdr-workflow skill](.agents/skills/herdr-workflow/SKILL.md) 通过主会话 Shell 调用 herdr CLI，默认 Codex full access，Claude auto。配置见[能力说明](docs/capabilities.md)，真实闭环见[验收记录](docs/personal-herdr-skill-acceptance-20261013.md)。固定 HerdrExecutor 已退役；直接 CLI 帮手通过 skill 查询和停止，中断后核对实际状态，不承诺 Host 统一停止或自动恢复。

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

2026-10-12 的 Windows/herdr 与 Telegram 证据是 #157 历史基线，见 [原实机记录](docs/personal-telegram-acceptance-20261012.md)。#167 的原生发现、来源回执、父子续接和实际进程死亡恢复有公共夹具验证；本轮真实 Anthropic、Telegram 完整矩阵仍未验证。Codex unelevated 只有部分写边界，当前没有可执行的完整受限命令后端，详见 [本轮验收](docs/personal-agent-acceptance-20261013.md)。
