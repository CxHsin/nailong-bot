---
status: accepted
---

# 主模型目录由 Magpie 提供，选择归属会话并允许双端修改

2026-10-18，用户确认[设计结论 #242](https://github.com/CxHsin/nailong-bot/issues/242)：主助手只使用 Magpie 的模型目录，经 Magpie Agent 插件接入，替代 `.env` 中逐模型配置和直接连接主模型的入口。供应商、账号及模型目录由 Magpie 管理，Nailong 保存 Conversation 的模型选择和思考偏好。Telegram 和 Magpie 都可修改当前 Telegram 主 Conversation 的模型并回显，以最后一次明确用户修改为准；其他 Conversation 独立保存。目录刷新和重启不得覆盖选择。

采用此边界，是为了让用户在已使用的 Magpie 中统一管理模型来源，并在电脑与手机上调整同一助手；代价是主助手依赖 Magpie 连接及目录元数据，需要验证配置同步和双向回显。保留独立意图识别模型与外部 helper 的原有职责，不把主模型目录迁移扩大为所有调用的统一配置重写。

会话控制面板的查看和设置不等待整个 Processing Turn。新设置在当前模型请求结束后的后续请求使用，不中止当前请求，不重放已确认结果。换模型保留上下文和工作进度，较小窗口沿用原生压缩；仍无法承接则暂停说明。切换暂停工作的模型不自动恢复工作，明确继续时才使用当前选择续接。此决定保留 [ADR-0011](0011-durable-main-agent-and-conversation-queue.md)、[ADR-0012](0012-layered-memory-and-stable-context.md)、[ADR-0013](0013-contextual-input-routing.md) 与 [ADR-0015](0015-system-context-order-and-self-file.md) 的执行、队列、上下文、记忆和系统指令边界。

首版 Telegram 支持按模型调整并保存思考等级；Magpie 的通用 Agent 插件目前只提供模型字段，因此 Magpie 端等级控件延期，以[后续 #243](https://github.com/CxHsin/nailong-bot/issues/243)跟踪上游 PR，不以修改或自编译 Magpie 作为首版前提。面板入口、常用列表、故障反馈和保存规则见[已确认讨论记录](../research/conversation-control-panel-design-2026-10-18.md)。本 ADR 记录设计决定，尚不代表实现或接入验收完成。

正式规格为 [Issue #244](https://github.com/CxHsin/nailong-bot/issues/244)，见[本地规格归档](../research/conversation-control-panel-spec-2026-10-18.md)。规格通过 Assistant Service 与 Telegram 的组合入口验证实际请求、同步、持久状态和工作操作，真实 Magpie 回显另需实际接入证据。

## 后续设计调整：全局路由模型也使用 Magpie 目录

2026-10-19，用户在[设计结论 #259](https://github.com/CxHsin/nailong-bot/issues/259)中确认：`/start` 增加独立的“全局路由模型”选择入口，与主模型共用 Magpie 目录，但分别保存选择。路由模型沿用整个 Assistant Service 共用的范围，不按 Conversation 分开；切换从下一次路由判断生效，重启后保留，不重新执行已有判断或改变工作状态。完整结论见[讨论归档](../research/nailong-persona-design-2026-10-19.md)。

这项决定扩展前文“仅迁移主模型目录，保留独立意图模型配置”的范围，以统一模型来源和面板管理为收益，同时保留两类模型的职责及选择独立性。正式规格为 [Issue #260](https://github.com/CxHsin/nailong-bot/issues/260)，见[本地规格归档](../research/nailong-persona-spec-2026-10-19.md)。下文 2026-10-18 的主目录实现记录保留其当时基准；后续路由及互动接入见文末。

## 实现状态

2026-10-18，实现任务 [#245](https://github.com/CxHsin/nailong-bot/issues/245)、[#248](https://github.com/CxHsin/nailong-bot/issues/248)、[#246](https://github.com/CxHsin/nailong-bot/issues/246)已接入现役 Assistant Service、Queue System、SQLite 和 Pi Durable；正式 Telegram/CLI 入口只从 Magpie 选择主模型，旧逐模型环境项仅保留独立意图分类的用途。`controlSnapshot` / `control` 提供统一查询与操作，原生面板复用这些操作；请求 checkpoint 冻结设置，后续 prepare 读取新选择，已确认工具结果和上下文保持。

仓库内提供 [Agent 插件](../../plugins/nailong-agent/README.md)，共享配置默认在 `~/.config/nailong/magpie.json`，覆盖入口为 `NAILONG_MAGPIE_CONFIG`。偏好与配置观测记录保存在现有 `assistant.sqlite`；首次没有有效模型时保留输入等待选择，暂停工作仍需明确继续。等级只来自目录，扩展 effort 在现有 provider 编码边界保留。

交付与验证由 [#247](https://github.com/CxHsin/nailong-bot/issues/247)跟踪，见[控制面板验收](../conversation-control-acceptance-20261018.md)及[操作说明](../personal-agent-operations.md)。本机 Magpie 0.1.1285 的真实目录只读查询成功；插件安装、真实双端菜单回显和 Telegram 手机操作尚未验收，代码实现与模拟测试不代表生产服务已切换。

2026-10-19，按[设置协调规格 #251](https://github.com/CxHsin/nailong-bot/issues/251)收拢设置生效职责：[会话设置协调 module](../../src/assistant/conversation-settings.ts)负责快照、每会话串行同步、全会话传播、配置 Durable、可运行性与同步任务的等待和关闭。Magpie 继续负责连接、目录、会话设置的持久保存、双端选择观测和发送前校验；Durable 继续冻结当前请求并为后续请求准备配置；runtime 组合这些能力并执行路由与队列调度。

控制查询仍等待全部会话的设置传播，包括等待期间新增的任务；被等待的同步失败使查询拒绝。等待空闲保留单次等待当前设置任务的语义，关闭则先停止协调唤醒，再循环排空设置任务，随后释放执行器与存储。公开 Assistant interface、旧模型配置注入路径和现有数据格式保持兼容，设置变化不自动恢复 Paused Work。本次结构调整的验证见[控制面板验收中的设置协调记录](../conversation-control-acceptance-20261018.md#设置协调职责收拢2026-10-19)。

## 路由目录与奶龙互动实现（2026-10-20）

[#261](https://github.com/CxHsin/nailong-bot/issues/261) 将路由选择保存为服务级偏好，共用 Magpie 连接和目录；设置协调在每次分类开始时准备快照，在途请求不切换，既有决定不重算。生产环境不再读取独立路由别名/供应商配置；未选择、不可用和分类失败保持原输入兜底。主模型选择、thinking、插件共享字段和工作事实独立保留。显式旧配置注入仅供历史协议夹具使用。

[#262](https://github.com/CxHsin/nailong-bot/issues/262) 与 [#264](https://github.com/CxHsin/nailong-bot/issues/264) 扩展原有控制快照及面板；表达频率、饱食度、投喂去重、收录素材和互动动作身份保存在现有 SQLite。运行材料追加当前偏好，不改写 SELF 身份或稳定记忆快照；贴纸与回应在授权 Channel 再检查范围和安静档，沿用发送回执。

[#263](https://github.com/CxHsin/nailong-bot/issues/263) 在生产启动组合入口增加一次可取消、有总时限的辅助生成，冻结当时主模型及 thinking，只使用基础指令、SELF 和启动事实。测试不提交普通用户输入、不恢复暂停工作；结果与发送分别记录，辅助 usage 不进入业务缓存统计。自动化证据与真实接入范围见[本次验收](../nailong-persona-acceptance-20261020.md)。
