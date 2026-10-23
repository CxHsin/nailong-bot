> 历史材料：下文的结论、状态与验证属于原文日期和基准。现行职责见[相关 ADR](../adr/0011-durable-main-agent-and-conversation-queue.md)，运行方式见[操作说明](../personal-agent-operations.md)；本地规格归档的权威版本仍为原文链接的 Issue。 原核对源码基准：`727a294293463332e55558fa3e5ba518719d6890`。

# 外部编码委派在 Personal Agent 中的定位

历史记录：固定执行器已由项目 skill 取代；当前入口见 [能力说明](../capabilities.md)。旧实现基准见 [HerdrExecutor](https://github.com/CxHsin/nailong-bot/blob/3a7760bea6c7d85e233c3f0eae3eb592b144a958/src/personal/herdr.ts)。

调研日期：2026-10-12。以下是当日官方主分支文档/源码快照；不是已验证本项目实现的迁移规格。

## 结论

建议将 herdr 定位为本体可调用的「编码委派能力」，以工具暴露、以有归属的子任务执行。语义上由本体负责拆分目标、决定委派、接回结果和继续工作；基础设施仍由 Host 负责权限、目录资源、执行身份、取消、重启对账。herdr 是外部 coding harness 的桥接与生命周期适配器，真正的 subagent 是被委派工作的 Codex/Claude Code 等执行会话。

这不要求把外部执行器进程塞进 Pi 原生 Conversation，也不要求删除现有 Host 的保护。不同运行时可以在基础设施层并列，用户目标责任链仍然是父子关系。

## 代表项目与第一手证据

### 1. OpenClaw：最直接的外部编码 Agent 对照

来源：
- https://github.com/openclaw/openclaw/blob/main/docs/tools/acp-agents.md
- https://github.com/openclaw/openclaw/blob/main/docs/tools/acp-agents/delivery.md
- https://github.com/openclaw/openclaw/blob/main/docs/tools/subagents.md

ACP 文档明确说明通过 backend plugin 调用外部 coding harness，ACP runtime 拥有 session 及其 cancellation。外部 ACP session 与 native subagent runtime 区分，不能因为都叫子任务就假定同一隔离和恢复语义。

Delivery 文档的「Parent-owned one-shot ACP sessions」直接规定：父 agent 用 `sessions_spawn({ runtime: "acp", mode: "run" })` 发起工作，孩子运行在自己的 harness session、使用后台 lane，结果经 task-completion announce 返回；父 agent 改写为正常助手回复。原文："Do not treat this path as a peer-to-peer chat between parent and child. The child already has a completion channel back to the parent."

Subagents 首页明确：内部 QA、research、coding、review、test lanes 结果返回父任务；仅在用户要求独立 session 或需要独立回来 steer 时才创建 persistent visible session。长运行、PR/report、isolated worktree 本身不把 worker 变为独立面向用户的任务。

反证/另一种合法模式：同一 Delivery 文档支持 interactive ACP session，用户后续消息直接路由到 coding harness，并把输出直接发回频道。这支持「用户明确进入专用 coding workspace」的产品需求，不支持把所有编码默认剥离为平级目标。

### 2. nanobot：个人本体 + 有 owner 的后台子任务

来源：
- https://github.com/HKUDS/nanobot/blob/main/README.md
- https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/subagent.py

README 自称 self-hosted personal AI agent runtime，包含渠道、长期记忆、MCP、multi-agent delegation、定时自动化。

SubagentManager 源码将任务绑定 `status.owner`，查询、发消息和取消通过 `_owned_status` 核对父 session 所有权。`_announce_result` 的 docstring 是 "Announce the subagent result to the main agent via the message bus." 注释进一步说明用 session_key_override 将结果送到主 session pending queue，"instead of being dispatched as a competing independent task"。

生命周期也不是简单调用函数：取消等待仅有界等待；不响应取消的 work 保留跟踪与 slot，直到真正退出。`recover_interrupted` 明确要求 host 已取得执行 ownership 后才恢复观测。

范围限制：这份代码是 nanobot 原生 subagent，不能据此声称它已经通过 ACP 调用外部 Codex。可借鉴的是 owner/control/result-return 责任链。

### 3. Letta Code：具有身份和记忆的本体，可将编码能力作为子 agent

来源：
- https://github.com/letta-ai/letta/blob/main/README.md
- https://github.com/letta-ai/letta-code/blob/main/README.md
- https://github.com/letta-ai/letta-code/blob/main/src/agent/subagents/builtin/general-purpose.md
- https://github.com/letta-ai/letta-code/blob/main/src/agent/subagents/manager.ts
- https://github.com/letta-ai/letta-code/blob/main/src/tools/subagent-tool-policy.ts

当前 Letta 主库 README 已明确当前代码在 letta-code，旧 V1 API server 在 archive 分支，因此没有套用旧 Letta multi-agent API 的描述。

Letta Code README 将其定位为 stateful harness，有长期身份和记忆，可以 always-on/proactive，接入 Telegram/Slack 等渠道。功能表描述 built-in subagents（general-purpose/forked/recall）以及 agents 调用其他 agent 作为 subagent。

`general-purpose.md` 声明 full-capability research/planning/implementation agent，原文："You are a specialized subagent launched via the Agent tool"，"your final report is how your work reaches your parent"，并要求 ONE final report。`manager.ts` 负责 headless CLI spawning、final report 收集、并行，携带 `parentAgentId` 标签；远程 computer 分支通过 Cloud status API 跟踪真实 turn，不把 enqueue receipt 当执行完成。

意义：本体可以具备长期身份/记忆，而编码 worker 仍有独立进程/上下文/执行位置，职责层级并不随进程独立而升级。

局限与不可照搬：这仍是 Letta 自身 CLI worker，不等于任意外部 harness 互操作；manager 某些分支使用 unrestricted permission 模式，不能把该策略直接当作本项目授权规范。

### 4. Pi Durable：适合承载父子关系，但不会自动接管外部副作用

来源：
- https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-foreground.ts
- https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts

README「Abort and Subagents」通过自定义 defineTool 在 api.commit 中创建 `ownership: { kind: "task", taskId: api.taskId }` 的 Conversation，重放查回已存在 child；稳定 requestId 避免重复 submit。普通 child 随 owner abort；background anchor 则与父的短期 idle/Esc 分离，并通过 reporter task 将答案作为 follow-up 回父。这为「长期子任务仍是子任务」提供直接机制。

它没有给出一个自动包装任意外部 herdr/Codex 进程的 native createSubagent API；示例是自定义工具驱动本 Harness 内 Conversation。要桥接 herdr，应自定义持久化任务保存 upstream execution/session ID，恢复时查询并重接结果，并实现取消对账。

README「Tools」规定工具在副作用前提交 intent；只有 `replay: "safe"` 在进程中断后重跑，否则给模型 interrupted。调用外部编码器不能仅因 Durable 本身持久化就声明可安全重新启动：必须先保证稳定请求标识、查回已有执行或可靠的不重复启动协议。

该包仍标注 Experimental，API 会改变。

## 推荐责任划分（设计推断，区别于以上事实）

用户任务 -> 本体（Pi Durable） -> 自己用工具工作，或委派 coding child（herdr -> 外部编码 agent） -> 子任务结果回本体 -> 主任务验收/交付。

Host 横向管理整条链的安全和持久化，不需要以新用户 Task 的形式暴露每个 coding child。为每次 delegation 保存 owner Task/Attempt、要求 revision、upstream execution identity、workspace、状态、结果引用及停止确认。

工具不等于无状态 RPC。建议至少支持 spawn/query/steer/stop/collect，长任务用后台持久化子任务；不要堵住主会话输入循环。不同阶段实际需要哪些操作，应按 herdr 实际 API 和项目需求收敛。

子执行的 done 是已返回结果/执行结束；本体仍需解释结果、继续其他步骤；本项目独立 Acceptance 继续决定整个用户目标是否满足。调研材料未证明这三个 personal agent 都默认带本项目同等级独立验收器，不应虚构这种共识。

## 哪些情况应提升为独立会话/顶层执行模式

- 用户明确要求长期专用编码工作区、直接与 coding agent 对话并持续 steer。
- 产品主要用途已是管理许多并列 coding workspaces，而非统一个人助手。
- 完整纯编码任务可以整项交给 harness，Host 保留 policy/acceptance/delivery，减少父 agent 的重复推理。

后者不必与父子设计冲突：整项委派可以是一个根目标下唯一且完整的 child。决定是否需顶层入口的依据应是用户是否要直接管理它，而非仅仅运行时不同、时间长或拥有 worktree。

## 调研范围与本项目基准

这是选择性代表样本，不是全市场统计；未对外部产品执行安装或运行测试。官方主分支链接会随时间变化。

本项目基准为 e31d20e（development，2026-10-12）。当前 Task.executor 在 src/personal/types.ts 定义为 local 或 herdr；src/personal/runtime.ts 根据该字段选择平级 TaskExecutor。本文建议改为任务内部的编码子委派，但尚未修改运行时，也未替代 ADR-0007。
