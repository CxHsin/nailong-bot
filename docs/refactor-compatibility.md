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
| 旧 createApp、旧执行/输出路径 | 已核对生产、诊断、迁移与测试调用；迁移有效覆盖后退役执行器，保留旧数据解释，详见下表。 |
| 诊断、迁移与验收 CLI | 保留只读、脱敏、临时派生文件和旧数据对照保证；仍使用的事实/协议解释不能随旧执行器删除。 |
| 脚本、hooks、CI、资产与依赖 | 保持原状；已有分支保护、构建身份与清理规则，无本轮结构修改依据。 |
| 测试、README、领域文档与研究 | 迁移有效回归与修正文档；保留历史 ADR/研究证据，用户未跟踪材料不加入提交。 |

生产 Telegram/CLI 均使用 `createAgentHost`；退役前 `createApp` 只有测试调用。其自然语言遗忘、实时旧协议和完整旧交付恢复未接入生产。旧执行器退役与旧数据解释分别判断。

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
| 图片、文件工具、长工具结果与归档恢复 | `telegram-images`、`local-files`、`runtime-log`、`web-result` 迁移到当前 Telegram/Host/Agent；必要原始数据与编码检查独立保留。 |
| 当前 Host 的公开进展与缓存报表回复 | `ui-projection`、`reply-context` 使用当前 plain/native Provider；旧阶段结果资格作为原始历史事实检查保留。 |
| CLI 输出和图片、跨 Channel 续聊 | `cli-channel`、`command-channels`、`cross-channel` 与真实子进程；保留模块 API，不增加用户命令。 |

`output-protocol` 保留历史消息所需的 `protocolText` 编码；通用 Delivery reducer 被 Host 恢复引用；旧目录中的 Telegram 图片输入仍在生产使用。历史记忆初始化已独立选择历史范围与因果前缀，不调用在线 Context Projection。

## 最终交付记录

2026-10-10，完成 #144–#149 后在 `development` 运行最终检查：`npm run typecheck` 通过，`npm test` 共 **367/367** 通过，0 失败、取消、跳过或待办，用时约 94.6 秒；`npm run build` 通过。最终状态和独立评审记录发布到 [#150](https://github.com/CxHsin/nailong-bot/issues/150)。

基线 421 条与当前 367 条的对应如下。展开后的旧用例逐项记录在 [#149](https://github.com/CxHsin/nailong-bot/issues/149) 的三个迁移评论中；合并及退役均附原保证、当前证明或旧内部契约的退役理由。

| 用例范围 | 基线 | 当前 | 对应依据 |
| --- | ---: | ---: | --- |
| 记忆、初始化与学习 | 46 | 47 | 真实 Telegram/Host 验收与独立原始旧数据检查；一条混合保证拆为当前交付失败和历史阶段成果学习两条。 |
| 工具、上下文与输入控制 | 70 | 64 | 保留实际工具与连续上下文，退役旧 envelope 分支及旧执行器三轮范围；补当前工具阻断和十二步无工具上限。 |
| 应用、Telegram 展示与交付 | 91 | 34 | 迁移有生产价值的行为并合并重叠保证；明确退役旧 HTML 增长式展示、envelope 解析和旧自动恢复。 |
| 本轮新增独立验证 | 0 | 8 | 事实读取 1、真实 CLI 控制 1、历史编码 2、真实 Telegram 验收夹具 4；类型正反例另外由 typecheck 检查。 |
| 其他既有覆盖 | 214 | 214 | 能力、所有权、CLI、模型切换、交付、算法等既有验收保留。 |
| 合计 | 421 | 367 | 测试数量变化不作为结构收益；主要依据为逐项行为证据。 |

关联检查不能与全量结果相加。迁移中的初次失败和修正原因保留在各 Issue 记录；最终全量没有失败。最终链接/入口核对检查变更文档的本地链接、退役 API 悬空调用与整个差异的空白错误。

变更均在 `development` 提交和推送，未纳入用户已有未跟踪材料。没有启动或重启生产 Bot，没有部署或合并 `main`。本地 Provider/transport 测试不证明真实 Telegram 客户端视觉效果、远端缓存命中率、KV TTL、费用或性能收益；本轮未执行真实凭据验收。插件和 #151 的原有缺陷留待后续确认。

## 已完成的职责改善

| 改动 | 原有牵连 | 当前边界 |
| --- | --- | --- |
| 生产事实类型（#145） | 开放记录允许必要身份或载荷遗漏，读取处重复解释归属与结算 | 复用现有事实联合类型与校验；Host、模型、工具、Context 和交付写入受类型约束，共享纯事实读取。旧记录原文与 schema 不变。 |
| 共享命令（#146） | Host 为公共命令构造 Telegram Update，共享流程承担 Channel 数据形状 | CommandInput 显式提供 owner、Conversation、消息与 reply 身份；命令返回正文，Host 协调控制。AgentExecution 和 Channel 契约只提供实际所需能力。 |
| Agent 生命周期（#147） | Pi 装配同时处理模型选择、连接、能力冻结和 Steer 执行协调 | agent-models 管理模型与认证；run-capabilities 管理连接和每轮冻结；run-session 管理执行与清理。Pi 保留 SDK 装配与记忆生命周期，已有目录和工具实现复用。 |
| 历史重建（#148） | 历史记忆初始化调用在线 Context Projection，间接依赖在线迁移与增量状态 | 两个调用方独立选择原始因果范围，共用 history-scope/history-facts 的纯解释和 history-codec 的 Provider 编码。在线调用方拥有 seed、边界和成功后提交；历史调用方拥有预算与学习协调。 |

预算、checkpoint、原始/部分/摘要覆盖、召回与学习算法已有明确职责，本轮保持原状；拆除跨 Projection 调用不改变其政策。历史工具消息使用当时冻结的 bounded view，summaryMessages 仍保留完整材料。重建维持原每 32 条让出及实际归档等待点，未增加逐事实异步等待。

### 独立记录的原有缺陷

[#151](https://github.com/CxHsin/nailong-bot/issues/151) 在新建测试 SQLite 上复现：历史初始化处理没有活动起点的旧 Conversation 轮次时，会把模拟因果前缀的活动起点写入真实日志，随后真实前缀校验失败。原实现和提取后的实现表现一致。修复尚未获得维护者确认，本轮保留原行为；这不是已验证成立的恢复保证，也不代表检查过生产数据。

## 退役与保留依据（#149）

调用核对覆盖 `src/`、`scripts/`、诊断/迁移入口及 `test/`。测试剩余调用不是单独的退役或保留依据；逐例迁移结果记录在 #149。

| 路径/接口 | 调用与独有语义 | 决定与证明 |
| --- | --- | --- |
| `application/app.ts`、`legacy-commands.ts` | 仅旧测试使用的重复排队、鉴权、命令、执行与恢复；自然语言遗忘和旧 reset 专属行为 | 退役。当前入口验证去重、prompt/reset、图片、工具和失败；自然语言句子按生产模型输入处理，遗忘使用 `/forget`。 |
| `telegram-delivery/projection/output/legacy/types/events/format/layout` | 旧执行器及旧 UI 测试依赖；HTML growing output、完整旧交付重启核对 | 退役。当前 Rich transport/原生草稿、Unicode/代码块分页、已知拒绝/未知结果与有界交付继续验证。重启只提示中断，不增加旧自动补发。 |
| `projectRequestState`、`projectFinalAnswer` | 旧执行器、旧 delivery 和内部测试使用 | 退役。`projectDeliveredChat` 仍由 AgentHost 使用，独立保留；旧交付完整性由 `delivery-facts` 等原始事实解释。 |
| `Request.onText`、`PiAgentOptions.outputProtocol`、实时 JSON v2 parser/repair/preview/writer/prompt | 无当前生产、诊断或迁移 live caller；旧实时 envelope 纠正及阶段结果循环 | 退役。当前 plain/native 进展、final、工具、断流、取消、Steer 和持续无工具上限继续验证；历史结构化 `protocolText` 编码保留。 |
| 共享命令的 `onStarted` 回调 | 只由旧 adapter 使用；真实 Channel 自己确认输入接受 | 随 adapter 退役，公共命令返回正文。当前存储失败验证 Provider/工具不执行、事实边界与重启重试，不把旧接受回调时序接入生产。 |
| 原始 JSONL/SQLite 导入、upcast、身份/归属、归档、旧 delivery/result/learning 解释 | 实际数据、当前恢复/记忆、诊断及迁移消费者 | 保留原政策。旧夹具保留原身份和缺失归属；历史学习重试显式调用提交算法，fixture.restart 不补执行学习或交付。 |
| `telegram-input.ts`、`telegram-markdown.ts`、`app-types.ts` 的 Update/Message/Request/DeliveryRejected | 当前 Channel、Agent、Host 和 Rich transport 实际使用 | 保留。目录或名字与旧执行器相近不能作为删除依据。 |

真实 Telegram 验收夹具取得目录所有权后装配当前 Channel/Host/Agent/runtime-v2，调用本地 Provider，暴露明确的 rootLog/scopedLog；默认关闭后台历史初始化，重启只使用当前恢复逻辑。模型输出、实际 wire、持久终态与 delivery 分别断言。纯历史编码/资格、事务和算法检查保留在必要的低层入口。
