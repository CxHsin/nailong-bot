> 历史材料：下文的结论、状态与验证属于原文日期和基准。现行职责见[相关 ADR](../adr/0011-durable-main-agent-and-conversation-queue.md)，运行方式见[操作说明](../personal-agent-operations.md)；本地规格归档的权威版本仍为原文链接的 Issue。

# 个人智能体如何接收连续消息与调度下一轮

日期：2026-10-15。状态：一手资料调研；用于继续讨论 nailong 合批规格，不表示用户已接受下述候选策略。

后续确认：用户已采用“当前轮结束或会话空闲时读取已排队连续普通消息，不等待时间窗，保留身份与边界”的方向，并明确只有 Telegram 显式 `/steer` 才用于运行中补充。以下调研保留选型时的语境；最新规则见[行为记录](event-queue-durable-workflow-2026-10-15.md)。普通新消息继续排队，不自动进入当前轮次。

## 结论

Grok Bot 官方文档明确：用户直接消息优先于后台工作，可以改变当前工作的方向；明确的“Stop now”用于立即停止。但所查官方文档没有公开普通消息的队列、合批或时间窗算法，不能据此声称 Grok Bot 使用或不使用某种合批机制。

公开源码呈现出多种不同机制：Grok Build 可以在空闲取队列时合并连续合格项；nanobot 在模型调用边界取已到达消息的有限快照，也在 Telegram 层使用计时缓冲；Hermes 的 queue 模式可以按静默窗合并忙碌期间的普通文本，但显式 `/queue` 要求逐条完整执行。这些都不是“判断两句话是否属于同一语义”的算法，也没有证据证明固定 800 ms 是个人智能体的通用做法。

此前提出的固定 800 ms 建议已撤回。用户并未因此决定禁止一切合批；具体选择仍待确认。OpenClaw 不在本次调查范围。

## 比较

| 对象与证据层级 | 已核实的处理方式 | 时间窗与边界 | 对 nailong 的意义 |
| --- | --- | --- | --- |
| Grok Bot：官方产品文档 | 直接用户消息优先于后台工作，可改变当前方向；支持显式停止 | 未公开普通连续消息的合批、同级抢占与恢复算法 | 支持优先级方向，不能作为合批实现依据 |
| Grok Build：官方公开源码，独立终端产品 | 可选地合并队列开头连续合格的普通 prompt，空闲时出队 | 所查合并函数按队列类型与编辑状态判断，不等待时间、不判断语义 | 可借鉴空闲时合并已排队前缀，以及保留原文展示；不能外推 Grok Bot 后端 |
| nanobot：公开源码 | 每会话一个 worker；模型调用前及结束答复前可注入已到达消息快照 | Agent 层快照不主动等待；Telegram 另有 200 ms 乱序重排与 600 ms 相册组装 | 可借鉴有限快照、FIFO 屏障与转换失败回放；运行中注入与 nailong 已定同级 FIFO 不同 |
| Hermes：公开源码与项目文档 | queue 模式忙碌普通文本可合并；显式 `/queue` 每条独立执行；`/steer` 另有当前运行注入 | 忙碌文本默认静默窗 350 ms、首条起上限 1 s；当前轮结束会强制 flush | 证明确有定时 debounce 实践，但它是特定模式策略，不能说所有入口默认如此 |

各项依据与限制见下文。

## Grok Bot：能确认优先级，不能确认合批算法

使用 xAI 官方文档索引确认产品身份，避免把第三方同名 Telegram Bot 当作官方实现。所读页面未给出可固定的发布日期、文档版本或服务端源码版本，以下是 2026-10-15 获取的产品说明。[官方文档索引](https://docs.x.ai/llms.txt)

官方聊天文档支持工作进行中继续发送指令，并写明：

> A direct message from you takes priority over background work and can redirect the current turn.

同页要求工作立即结束时发送直接的“Stop now”，并说明这不会撤销已完成的操作。这证明产品暴露“直接消息高于后台”和“明确停止”的语义；没有说明打断发生在模型调用中、工具调用中还是调用间，也没有说明两条同级直接消息是否互相抢占。[Chat and collaboration — Redirect work in progress](https://docs.x.ai/grok-bot/chat-and-collaboration#redirect-work-in-progress)

Slack 接入说明：DM 中回答每条消息，整个 DM 是一个 conversation；频道或群 DM 在被 @mention 后跟进该 thread，每个 thread 是独立 conversation。这是接收与会话划分语义，不能推导“每条消息必须单独调用一次模型”。[Team Bots — How the Bot behaves in Slack](https://docs.x.ai/grok-bot/team-bots#how-the-bot-behaves-in-slack)

官方说明关闭应用、电脑或手机后云端工作继续，证明客户端关闭不结束云端工作，不能用作服务进程崩溃恢复或输入队列持久性的证据。[Overview — Does Grok Bot keep working when my laptop is closed?](https://docs.x.ai/grok-bot/overview#does-grok-bot-keep-working-when-my-laptop-is-closed)

在所查官方产品文档和 xai-org 公开仓库中，没有定位到 Grok Bot 服务端普通消息调度实现。因此本次无法回答其是否使用固定窗口、动态窗口、语义判定、队列快照、原始事件去重或持久 FIFO。文档中的 routine 调度最小间隔属于定时任务频率，不能解释为聊天消息的合批窗口。[Skills, routines, and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations)

## Grok Build：可选的队列前缀合并

另行检查 xai-org 的 Grok Build，固定版本为 `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`。其 README 将其定义为终端 AI 编程工具；它是与 Grok Bot 不同的产品，公开代码不能代表 Grok Bot 服务端。[README](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/README.md)

队列合并规则由 `[ui].combine_queued_prompts` 控制。所查 pager 出队路径先要求 session 处于 idle，并检查模型切换、回放、正在编辑队首等屏障；之后根据配置选择 `dequeue_combined_prompt` 或单条 `dequeue_prompt`。这里确认的是该空闲出队路径，并未核实配置默认是否开启，也不宣称项目所有入口都没有时间窗。[空闲与其他屏障](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/dispatch/queue.rs#L315-L385)、[选择合并或单条出队](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/dispatch/queue.rs#L388-L401)

共享纯函数只取队列开头的连续合格前缀：普通非空用户 prompt；不包含 synthetic/auto-wake、展开的 skill、bash；后续项还不能带图片或处于编辑保留状态。遇到第一个不合格项就停止，不能跨过它去收集后面的项。文本按两个换行拼接，元数据保留原文列表供多气泡展示。这是结构和顺序判断，未使用语义分类器，也没有在此函数内等待凑批。[合并规则与原文元数据](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-prompt-queue/src/combine.rs#L1-L90)

shell 侧合并会把 follower 文本折叠到队首，并把被移除行完成为 `RemovedFromQueue`。这意味着“保留原文用于展示”不能直接等同于“每个原始事件仍有独立、可恢复的执行状态”；nailong 若采用多事件一轮，仍需设计自己的持久身份和完成协议。[shell 合并实现](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/prompt_queue.rs#L1072-L1101)

## nanobot：有限快照注入与渠道计时缓冲并存

固定版本：`841d2b880ca7a7d21e7b64476799b9af341b1ee0`，仓库 `HKUDS/nanobot`。

Agent 层按 session 建立队列和唯一 worker。已接受的用户输入处理完后才取 idle-only automation，不让这些后台自动任务越过已有用户输入。[会话入队与 worker](https://github.com/HKUDS/nanobot/blob/841d2b880ca7a7d21e7b64476799b9af341b1ee0/nanobot/agent/loop.py#L1446-L1496)

`_drain_pending` 先记录 `qsize()`，再以 `get_nowait()` 取这一有限快照；转换消息时即使发生 await，新到消息也不会无限扩张本次快照。独立轮次入口构成 FIFO 屏障，只转换其前方可注入的连续项；失败或取消时，尚未消费的前缀回到后来到达消息之前。这条 Agent 层路径没有为收集用户文本而先等待一个固定时长。[快照边界](https://github.com/HKUDS/nanobot/blob/841d2b880ca7a7d21e7b64476799b9af341b1ee0/nanobot/agent/loop.py#L1024-L1044)、[屏障与失败回放](https://github.com/HKUDS/nanobot/blob/841d2b880ca7a7d21e7b64476799b9af341b1ee0/nanobot/agent/loop.py#L1117-L1136)

但该机制会在每次模型调用之前，以及最终答复结束前再次取 pending messages；因此普通新用户输入可以进入当前 run 的下一次模型调用。这与 nailong 已确认的“同级新输入不抢占当前轮次，排到后续轮次”不同，不能直接照搬。[模型调用前注入](https://github.com/HKUDS/nanobot/blob/841d2b880ca7a7d21e7b64476799b9af341b1ee0/nanobot/agent/runner.py#L442-L456)、[最终答复前再次检查](https://github.com/HKUDS/nanobot/blob/841d2b880ca7a7d21e7b64476799b9af341b1ee0/nanobot/agent/runner.py#L696-L720)

测试源码覆盖多条原始用户消息保留为各自消息、在同一模型请求中可见，以及转换期间后来到达的消息不进入当前快照。它证明代码意图和测试约束，本次没有运行这些测试。[八条消息与有限快照测试](https://github.com/HKUDS/nanobot/blob/841d2b880ca7a7d21e7b64476799b9af341b1ee0/tests/agent/test_runner_injections.py#L1236-L1368)

不能由 Agent 层快照推广为“nanobot 不用固定时间窗”。同版本 Telegram runtime 有两类不同机制：

- **乱序重排**：每 session 缓冲 update，等待 200 ms，按 `(message_id, update_id)` 排序后逐条处理；这是渠道排序，不是按语义合并普通文本。[排序与缓冲](https://github.com/HKUDS/nanobot/blob/841d2b880ca7a7d21e7b64476799b9af341b1ee0/nanobot/channels/telegram/runtime.py#L1858-L1910)
- **相册组装**：相同 `chat_id + media_group_id` 的媒体进入同一组，等待 600 ms 后提交一个 turn；这是按 Telegram 提供的协议身份组装，不是推断两句话是否属于同一请求。[相册分组](https://github.com/HKUDS/nanobot/blob/841d2b880ca7a7d21e7b64476799b9af341b1ee0/nanobot/channels/telegram/runtime.py#L2030-L2048)、[等待与提交](https://github.com/HKUDS/nanobot/blob/841d2b880ca7a7d21e7b64476799b9af341b1ee0/nanobot/channels/telegram/runtime.py#L2064-L2077)

## Hermes：定时合并、显式排队和 steering 分开

固定版本：`73b9f2af7b87a619f42396710c332be04353aef2`，仓库 `NousResearch/hermes-agent`。

Hermes 确有基于时间的普通文本合并，但需限定模式：busy queue 模式下，普通、非 internal、非命令的同发送者文本可以合并。默认静默窗 350 ms，首条消息起硬上限 1 s；flush 时刻取“末条到达 + 静默窗”与“首条到达 + 硬上限”的较早者。后续文本以换行拼接，并重新安排 timer。[默认常量](https://github.com/NousResearch/hermes-agent/blob/73b9f2af7b87a619f42396710c332be04353aef2/gateway/platforms/base.py#L112-L113)、[模式资格与合并实现](https://github.com/NousResearch/hermes-agent/blob/73b9f2af7b87a619f42396710c332be04353aef2/gateway/platforms/base.py#L3773-L3841)

shared gateway 的 burst buffer 也按同 sender、同 kind 合并；sender 或 kind 改变时先 flush，避免把不同来源跨越重排。其 ACK 在 commit 后发出。这里按来源与类型判断，并没有语义分类。[分组、FIFO 与提交](https://github.com/NousResearch/hermes-agent/blob/73b9f2af7b87a619f42396710c332be04353aef2/gateway/session_ingress_burst.py#L44-L89)

不能把它写成所有入口的默认行为：gateway framework 配置默认 `busy_input_mode=interrupt`，旧的显式文本配置可覆盖文本策略；TUI 默认 queue。[gateway 配置默认](https://github.com/NousResearch/hermes-agent/blob/73b9f2af7b87a619f42396710c332be04353aef2/gateway/run_config_loaders.py#L245-L261)、[TUI 默认](https://github.com/NousResearch/hermes-agent/blob/73b9f2af7b87a619f42396710c332be04353aef2/gateway/session_busy_controls.py#L53-L68)

当前轮结束时会主动 flush 尚未到期的 burst，再取队首推进，因此这里并非规定“上一轮结束后仍必须额外等满 350 ms”。[轮次结束与 drain](https://github.com/NousResearch/hermes-agent/blob/73b9f2af7b87a619f42396710c332be04353aef2/gateway/platforms/base.py#L4628-L4640)、[finally flush](https://github.com/NousResearch/hermes-agent/blob/73b9f2af7b87a619f42396710c332be04353aef2/gateway/platforms/base.py#L4664-L4666)

显式 `/queue` 与普通 burst 不同：每条输入保留为独立完整轮次、FIFO、不合并。`/steer` 则尝试在当前 run 的工具迭代之间注入，另有 fallback；成功 steering 的消息不会再排成下一轮。[`/queue` 与 `/steer`](https://github.com/NousResearch/hermes-agent/blob/73b9f2af7b87a619f42396710c332be04353aef2/gateway/run_busy.py#L1048-L1097)、[成功注入去掉重复排队](https://github.com/NousResearch/hermes-agent/blob/73b9f2af7b87a619f42396710c332be04353aef2/gateway/run_busy.py#L856-L871)

项目文档还区分 shared authority 的 `session.steer` / `session.redirect` 与 queue：前两者被 runtime 接受不代表 crash-durable，显式 session 控制也不偷偷 fallback 为新轮。这与 adapter 的 `/steer` 命令 fallback 不是同一层接口，不能混写为统一保证。[Gateway internals](https://github.com/NousResearch/hermes-agent/blob/73b9f2af7b87a619f42396710c332be04353aef2/website/docs/developer-guide/gateway-internals.md#L159-L177)

## 对 nailong 的候选建议，待用户确认

已接受边界见 [ADR-0011](../adr/0011-durable-main-agent-and-conversation-queue.md)：nailong 保留会话持久队列，同级 FIFO；直接用户输入可抢占低优先级后台轮次；仅向 Pi Durable 提交当前轮次；herdr 返回是内部执行材料。研究结果不改变这些边界。

适合继续确认的候选是：在当前轮结束或会话空闲时，只取当时已经排队的有限快照；在同会话、同来源、同优先级的连续普通输入中，遇到命令、显式独立轮次或其他控制屏障就停止，不为凑批主动等待。一次模型调用可以读多条输入，但每条原始事件的身份、正文、顺序和恢复状态独立保留。它是执行时组织多条输入，不声称这些输入语义相同。

若采用这个候选，还需在规格里确认“一轮如何逐条记录完成/取消/重试”和“多条输入是否共享一个答复”。Grok Build 的原文展示元数据不能替代 nailong 的持久事件账本，nanobot 的 mid-turn injection 也不能默认覆盖同级 FIFO。

渠道乱序等待、平台相册组装、普通文本 debounce、队列快照和语义合并应分别决定。对某个普通文本等待窗的否定，不能推出渠道层永远不得计时；行业中存在定时 debounce，也不能据此要求 nailong 使用同样参数。

## 验证边界

本次为官方文档与固定提交源码静态审阅，没有安装或运行这些项目、没有执行其测试，也没有调用付费模型。引用测试表示审阅了测试约束，不表示本机通过。Grok Bot 页面为获取日的动态文档；其他三个项目引用固定 commit，不能自动代表之后版本。此文只研究消息接收与轮次调度，没有据此验证其他项目的端到端崩溃恢复。
