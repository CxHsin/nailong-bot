# Personal Agent 操作与验收

日期：2026-10-12；重构基准：`d03422048b6a22502e8ac1952ae3d3a434612bc1`。当前入口见 [README](../README.md)，目标为 [#157](https://github.com/CxHsin/nailong-bot/issues/157)。

## 配置

模型仍使用 `MODEL_NAMES`、`MODEL_DEFAULT`、`MODEL_<别名>_*`。`AGENT_CAPABILITIES_FILE` 指定 skillSources/mcpServers/executionTool JSON；路径和提示词在连接外部服务前验证。embedding、MEMORY_DYNAMICS、MEMORY_RECALL 作用于独立记忆检索与学习。

| 变量 | 默认/用途 |
| --- | --- |
| `AGENT_MAX_CONCURRENT` | 2，独立任务并发 |
| `AGENT_TASK_TIMEOUT_MS` | 1800000，执行时间预算 |
| `AGENT_MODEL_TIMEOUT_MS` | 120000，单次模型交互 |
| `AGENT_MAX_TURNS` | 40，工具轮次上限 |
| `AGENT_MAX_TOKENS` | 500000，执行用量预算 |
| `AGENT_MAX_ATTEMPTS` | 3，任务尝试上限 |
| `AGENT_MAX_DIALOGUE_ATTEMPTS` | 3，输入处理尝试上限 |
| `AGENT_HERDR_SESSION` | 具名专用会话，必填才能委派 |
| `AGENT_HERDR_KIND` | codex；Claude 缺少 verified policy 时拒绝 |
| `AGENT_SHELL_PATH` | 可选 Pi shell |
| `AGENT_VERIFICATION_CHECKS` | JSON 数组，确切 command/args/cwd，部署者预先授权 |
| `AGENT_CHECK_TIMEOUT_MS` | 120000，检查命令上限 |

本地执行与验收模型用量合并进入 Attempt 预算；herdr 外部执行用量未知，不能推定免费。验收受模型超时与 Task 取消信号约束。未知动作消费不能当作可安全重试。计划停机期间不运行，恢复按持久错过策略处理。

## 切换与回退

1. 停止旧 writer，对完整数据目录做外部备份，不同时运行新旧入口。
2. 先在副本启动 CLI。迁移只读旧源，备份源/归档/checkpoint/记忆后校验并提交一次 Session 导入清单。
3. 核对源摘要、会话身份与排除来源；坏活动边界/缺失归档拒绝迁移。不要删除标记绕过错误，旧委托不变成新 Task。
4. 上线前完成真实 Telegram 验收。正常退出保留任务，重启先核对执行者，不重复未知效果。
5. 回退前停止新进程并保存完整当前目录。旧代码不理解 personal.sqlite 的新增任务/授权/交付；使用切换前副本运行旧版，保留新目录及执行身份并人工核对未完成义务。仅 git 回退不能恢复业务状态。

本次实现不自动部署、启动生产 bot 或合并。

## 验证证据

| 保证 | 实际覆盖入口 |
| --- | --- |
| 并行/冲突、授权、持久输入、停止/恢复 | personal-host 测试，Host 输入+受控 executor |
| 原生 Session、文件、compaction、切换及遗忘 | personal-session，真实 Pi+本地 Provider |
| 生产工厂、独立成果读取与交付 | personal-runtime，Channel→runtime→Pi |
| Telegram 鉴权/对话/文件及未知分页 | personal-channel，grammy+受控 API |
| 计划修改、期限、错过及原子触发 | personal-plans，Host 输入+受控时钟 |
| 命令退出码/超时/进程树停止 | personal-verification，真实本机进程 |
| 只读导入、排除、坏边界/reset/restart | personal-migration |
| 所有权、崩溃、收件箱和未知恢复 | host-process，实际生产 CLI 子进程 |
| herdr 身份、改向和验收契约 | personal-herdr |

真实 Windows/herdr/Codex 已验证：实际文件42/64；计数进程停止于33，父子 PID 消失；崩溃窗口后同 Task 验收128且无新 prompt。临时具名会话已清理，默认会话未操作。详见[实机记录](personal-herdr-acceptance-20261012.md)。它不证明真实 Telegram 闭环。

2026-10-12 已获授权完成真实 Telegram 文字入站、真实模型回复、消息与文件出站，并根据实机失败修复默认任务目录及验收凭据。修复后同一授权目标通过结构化 Host 重试完成独立文件验收，附件消息470已发送；该重试不能算修复后的新自然语言入站。详见[Telegram 实机记录](personal-telegram-acceptance-20261012.md)。

仍待真实 Telegram 完整矩阵：修复后的自然语言接单、图片、运行中对话/改向、并行冲突、停止、活动任务重启及计划。基本收发不能替代完整验收。Claude 未启用，任意外部网络动作仍受执行器实际权限边界限制。
