# 整体重构的兼容验收

规格 [#143](https://github.com/CxHsin/nailong-bot/issues/143)；基线盘点 [#144](https://github.com/CxHsin/nailong-bot/issues/144)。本轮保留当前生产行为、配置、数据与技术栈，插件系统留待具体需求明确。此文记录可检查的边界和证据，不替代 Issue 中的规格。

## 重构前基线

2026-10-10，`development` 提交 `678314a`，Node.js 24.15.0。`npm run typecheck`、`npm run build` 通过；`npm test` 共 421 条，421 通过，0 失败、取消或跳过。全部验证使用测试临时数据和本地服务，未启动生产 Bot。

## 职责盘点

| 范围 | 处理与依据 |
| --- | --- |
| Host、输入队列、恢复与目录所有权 | 保留现有生命周期与时序，随事实类型与应用契约调整内部接口；不改变 Follow-up、Steer、Stop 和重启策略。 |
| 应用协调与共享命令 | 重构公共控制输入，消除伪 Telegram Update；保留去重、reply、身份映射、交付与学习时机。 |
| Agent 装配、SDK、能力与执行 | 按现有职责拆清装配与执行协调，保留工具目录、权限、Skill 冻结、协议和取消；不做插件接口。 |
| Context Projection、预算与 checkpoint | 整理准备接口，保留持续上下文、原始/摘要覆盖、冻结工具视图和失败保护。 |
| Akasha 准备、学习与历史初始化 | 消除历史初始化对另一 Projection 的调用，复用事实解释，保留历史因果范围、召回和学习算法。 |
| Runtime Log、SQLite、事实解释与归档 | 加强生产事实类型，保留原始旧记录、事件顺序/身份、批量原子性和旧数据解释；不迁移生产数据。 |
| Telegram、CLI 与启动入口 | 收窄依赖，保留各入口真实配置、输出、图片和交付差异；已合理的展示/transport 算法不重写。 |
| 旧 createApp、旧执行/输出路径 | 退役候选；先核对调用和独有行为、迁移有生产价值的覆盖，不能按 legacy 名称批量删除。 |
| 诊断、迁移与验收 CLI | 保留只读、脱敏、临时派生文件和旧数据对照保证；仍使用的事实/协议解释不能随旧执行器删除。 |
| 脚本、hooks、CI、资产与依赖 | 保持原状；已有分支保护、构建身份与清理规则，无本轮结构修改依据。 |
| 测试、README、领域文档与研究 | 迁移有效回归与修正文档；保留历史 ADR/研究证据，用户未跟踪材料不加入提交。 |

生产 Telegram/CLI 均使用 `createAgentHost`，`createApp` 只有测试调用。旧接口的自然语言遗忘、旧协议与完整旧交付流程不是本轮接入生产的新功能。旧执行器退役与旧数据解释必须分别判断。

## 不得统一的入口差异

| 项目 | Telegram | CLI |
| --- | --- | --- |
| 身份与输入 | 账号专属私聊、Bot 后缀、真实消息/reply ID、下载照片 | Actor 与可选 Conversation、文件图片输入 |
| 初始化配置 | embedding、记忆参数、按模型预算比例、运行身份 | 默认字面记忆与记忆参数，没有相应环境配置接入 |
| 展示与交付 | Rich Markdown、原生草稿、分页、贴纸 | 标准输出、JSON/NDJSON、stderr |
| 退出 | SIGINT/SIGTERM 停止 Channel | 忙时 Ctrl+C Stop，空闲退出；send 完成退出 |

两入口都在初始化日志与恢复前取得同数据目录所有权，退出先关闭 Agent 再释放所有权。抽取公共逻辑不能改变上表或获得所有权的顺序。

## 行为与验证对应

主要验收入口已经维护者确认：当前 Channel → 真实 Host/Agent → 本地模拟 Provider/MCP 与持久日志；纯算法、事务和编译约束使用必要的低层检查。

| 保证 | 现有验证与迁移要求 |
| --- | --- |
| Follow-up、多个 Steer、冻结技能/图片、Stop 边界 | `input-controls`；当前真实 Agent 与工具屏障。 |
| 单目录所有权、崩溃和重启提示、不重跑旧队列 | `host-process` 真实 CLI 子进程与 Telegram 输入控制回归。 |
| 命令不调用模型、会话设置隔离、即时缓存查询 | `agent-host`、`command-channels`、`cache-report-live`、模型切换；公共命令触及时核对真实模型请求覆盖。 |
| 工具发现/权限、MCP 故障、原生/兼容协议、Skill 安装/版本 | `capabilities`、`telegram-skills`、`model-switching`，真实 Host/Agent 与本地服务。 |
| Provider 断流、草稿不结算、工具只执行一次 | `provider-disconnect`，真实 Host/Agent。 |
| 持续上下文、冻结视图、压缩/遗忘、增量与完整恢复 | `continuous-acceptance`、`stable-tool-views`、`replay-cache`、`compaction-failures`、预算与记忆测试。 |
| 交付与学习、辅助进展排除、历史初始化因果 | `agent-host`、`active-memory`、`memory-dynamics`、进展相关测试；保留各自事实源。 |
| 旧记录、reset 身份、SQLite 事务、导入与归档 | `runtime-migration`、`sqlite-runtime-log`、`runtime-log`、`agent-host`、诊断相关测试。 |
| 图片、文件工具、长工具结果与归档恢复 | 现有部分测试依赖 createApp，删除前迁移有价值断言到当前入口。 |
| 当前 Host 的阶段结果与缓存报表回复 | `ui-projection`、`reply-context` 部分测试显式启用 JSON v2，不能仅凭标题当作生产 plain v3 覆盖；须逐项核对。 |
| CLI 输出和图片、跨 Channel 续聊 | `cli-channel`、`command-channels`、`cross-channel` 与真实子进程；保留模块 API，不增加用户命令。 |

`output-protocol` 仍被当前 Context Projection 的旧文本解释引用；通用 Delivery reducer 被 Host 恢复引用；旧目录中的 Telegram 图片输入仍在生产使用。删除旧路径时不能连带删除这些当前依赖。历史记忆初始化调用 Context Projection 是实际交叉，拆开时须保留其独立的历史范围和因果规则，不能换成当前持续范围。

## 最终交付记录

后续任务在各自 Issue 记录变更、实际检查及测试条数。本轮最终验收在此补充结构收益、退役/保留证据和完整验证结果；未测量性能、远端缓存、客户端视觉或真实服务费用，不作相应保证。
