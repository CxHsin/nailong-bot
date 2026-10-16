# 上下文输入路由验收记录

2026-10-16，[规格 #215](https://github.com/CxHsin/nailong-bot/issues/215)及其[本地归档](research/contextual-input-routing-spec-2026-10-16.md)的实现验收。实现前基准为 `bca14c1`，在 `development` 验证；本文不表示已部署或已完成真实 Telegram 验收。设计职责见 [ADR-0013](adr/0013-contextual-input-routing.md)，配置和日常操作见[操作说明](personal-agent-operations.md)。

## 受控行为验收

主要边界为 Assistant Service 的公开输入、输出、等待及同目录重开，使用真实持久队列、Durable 和本地 HTTP 模型服务。外部分类响应和 herdr 响应受控；以下结果验证路由、效果和恢复，不能证明真实模型的总体理解准确率。Telegram 项使用真实 grammY bridge 与受控 API，不等于真实服务器收发。

| 规格场景 | 可观察证据与测试入口 |
| --- | --- |
| A 运行时 B、C 到达 | [controls](../test/assistant-controls.test.ts)：普通输入等待、随后按序合批，当前工具不被普通请求中断 |
| 运行中自然语言补充 | [interaction](../test/assistant-interaction.test.ts)、[controls](../test/assistant-controls.test.ts)：下一模型请求带原文与身份，工具先正常结束 |
| 多条补充、重复投递 | [controls](../test/assistant-controls.test.ts)：顺序及来源去重；[service recovery](../test/assistant-service-recovery.test.ts)：重开不重复已消费效果 |
| 报表、天气、CSV 修改 | [routing](../test/assistant-routing.test.ts)：首次执行已带 CSV，天气及原身份保留 |
| 取消排队目标 | [cancel](../test/assistant-routing-cancel.test.ts)：取消目标无文件效果，同输入另一目标继续 |
| 一句话取消并新增 | [cancel](../test/assistant-routing-cancel.test.ts)：取消与新请求分别处理，新请求保留 FIFO |
| 只取消同批一项 | [cancel](../test/assistant-routing-cancel.test.ts)：共享执行中断，另一项续接，已确认文件写入不重复 |
| 唯一、明确及歧义对象 | [intent](../test/assistant-intent.test.ts)、[cancel](../test/assistant-routing-cancel.test.ts)：已知身份校验；歧义仅澄清，无候选取消效果 |
| Telegram 回复关联 | [telegram routing](../test/assistant-routing-telegram.test.ts)：原消息、输出多目标及未知回复；[helper routing](../test/assistant-routing-helper.test.ts)：控制通知关联对应 helper，避开无关主工作 |
| 分类与主 Bot 并发 | [controls](../test/assistant-controls.test.ts)、[helper routing](../test/assistant-routing-helper.test.ts)：主工具保持阻塞时分类及 helper 控制已经发生 |
| 主 Bot 忙时补充 helper | [helper routing](../test/assistant-routing-helper.test.ts)：持有主工具边界仍能观察对应 helper prompt，另一个 helper 不收错消息 |
| 旧 working 不等于采纳 | [helper control](../test/assistant-helper-control.test.ts)：CLI 接受仅为 sent，独立执行证据才变 adopted |
| blocked、身份变化、未知 | [helper routing](../test/assistant-routing-helper.test.ts)、[helper control](../test/assistant-helper-control.test.ts)：原文兜底、未知不重发、无改投 |
| helper 退出仍有子进程 | [helper control](../test/assistant-helper-control.test.ts)：确认清单才可 stopped；实际当前进程树不完整时 unknown，保留基础设施；真实限制见下文 |
| 判断期间目标完成 | [fallback](../test/assistant-routing-fallback.test.ts)：不注入旧执行，作为基于成果的后续输入 |
| 超时、错误、无效、未配置 | [fallback](../test/assistant-routing-fallback.test.ts)、[intent](../test/assistant-intent.test.ts)：主 Bot 收原身份和完整原文，说明分离；复合结果先整体校验 |
| 超时结果迟到 | [fallback](../test/assistant-routing-fallback.test.ts)：迟到取消不执行，原文只走既定兜底 |
| 文字或候选超预算 | [intent](../test/assistant-intent.test.ts)、[fallback](../test/assistant-routing-fallback.test.ts)：完整原文兜底，候选省略后不推断全局唯一 |
| 图片默认提示、需要视觉 | [telegram routing](../test/assistant-routing-telegram.test.ts)：无 caption 不伪造意图，实际主请求保留原图；caption 可独立判断 |
| 复合部分确认后失败 | [routing recovery](../test/assistant-routing-recovery.test.ts)：复用已落盘决定，已确认或未知 helper 发送不重复；原始身份与进度保留 |
| 接收、决定、发送边界强杀 | [routing recovery](../test/assistant-routing-recovery.test.ts)及其[子进程](../test/fixtures/assistant-routing-child.ts)：真实 SIGKILL 后同目录恢复，实际文件及发送身份断言 |
| 取消后重启、reset、resume | [cancel](../test/assistant-routing-cancel.test.ts)：持久取消不复活；[取消崩溃窗口](../test/assistant-cancel-recovery.test.ts)真实强杀后只续接幸存项，已确认写入不重复 |
| reset 与遗忘 | [telegram routing](../test/assistant-routing-telegram.test.ts)、[fallback](../test/assistant-routing-fallback.test.ts)：实际分类请求排除旧聊天、失效原文和派生摘要，保留独立执行身份 |
| 两会话与来源去重 | [fallback](../test/assistant-routing-fallback.test.ts)：外来目标无控制效果，同文不同身份独立接收 |
| 旧补充迁移、入口退役 | [service recovery](../test/assistant-service-recovery.test.ts)、[routing](../test/assistant-routing.test.ts)、[queue](../test/assistant-queue.test.ts)：消费与提交去重；新 `/steer` 仅提示自然语言 |
| 配置与上限 | [intent](../test/assistant-intent.test.ts)：独立别名、非流式无工具、无重试、预算及模型窗口校验 |

## 真实分类模型

命令：`node --env-file-if-exists=.env --import tsx scripts/acceptance/routing-live.ts EXTERNAL_OUTPUT_DIRECTORY ds`。运行[脚本](../scripts/acceptance/routing-live.ts)使用当前配置的 `ds` 别名，默认 8 秒超时，不修改 `.env`。外部原始证据位于 `C:/Users/Cx/AppData/Local/Temp/nailong-routing-live-20261016/classifier-results.json`，未保存凭据。

| 输入场景 | 结果 | 耗时 |
| --- | --- | --- |
| 中文新请求 | request，符合预期 | 2464 ms |
| 近期指代改 CSV | supplement → report，符合预期 | 2080 ms |
| 跨无关消息补充 | timeout，无控制动作；原文兜底 | 8014 ms |
| 明确取消报表 | cancel → report，符合预期 | 4896 ms |
| 多目标歧义 | clarify，符合预期 | 4503 ms |
| 取消图表并询问天气 | cancel → chart、request，符合预期 | 3547 ms |

这六条包含一次安全降级，不能宣称全部分类成功，也不推导总体准确率。超时不自动重试或采用迟到动作。

## 真实 herdr

在独立临时目录使用当前安装 herdr 0.8.2、Codex 0.162.0-alpha.17.2 和专用 agent `routing-live-1016-1`（默认 session，workspace `wN`，pane `wN:p1`）。真实 dispatcher 提交稳定补充 `live-supplement-1016-1` 时旧轮次仍在工作；helper 实际生成 `adoption.json`，经独立读取核对动作身份与原文后才确认 adopted。主 Bot 忙碌隔离由受控服务测试覆盖，本次真实 helper 验收未同时持有真实主 Bot 轮次。

首次真实取消发现阻断缺陷：当前进程树漏掉了已退出父进程的 heartbeat 子任务，旧判断错误报告 stopped，并误将 Codex 基础设施列为任务。修复后，默认检查保留 Codex 基础设施和共享 herdr；当前树不能排除孤儿任务，因此明确返回 unknown。以新动作 `live-cancel-1016-after-fix` 对同一真实 helper 复查，结果为 unknown，没有虚构停止。

heartbeat PID 35000 由验收者按 PID、启动时间和命令行精确核验后清理；进程消失且心跳文件两秒不再增长。这是人工清理证据，**不能作为自动终止孤儿进程的成功证据**。当前实现可停止已核实归属的现存任务子进程，缺少全量历史归属时必须交主 Bot 核查。没有新增全局名称终止或进程追踪平台。

完整报告和原始身份、发送、进程、清理证据位于 `C:/Users/Cx/AppData/Local/Temp/nailong-routing-herdr-live-20261016/REPORT.md`。故障现场保留，共享 herdr 服务和其他 pane 保留。

## Telegram 与交付检查

用户明确授权后，使用[真实验收脚本](../scripts/acceptance/routing-telegram-live.ts)接管 `@NibHsinBot` 测试轮询，数据保存在独立临时目录。首次测试中模型混用 Git Bash `/tmp` 与 Windows 路径，文件发送失败后搜索文件系统；已停止该进程，保留现场，并在验收提示中明确相对文件路径后重新运行。未改动生产数据或 `.env`。

第二次运行的真实记录位于 `C:/Users/Cx/AppData/Local/Temp/nailong-routing-telegram-live-20261016-r2/`：

| 真实消息及行为 | 结果与证据 |
| --- | --- |
| 551：生成两行报表 | 实际等待后写入 `report.md`；Telegram 文件消息 552、结果消息 553 均有 sent 回执 |
| 554：改 CSV | 到达时原报表已完成，作为后续修改写入 `report.csv`；文件 555、结果 556 均有 sent 回执。未覆盖运行中补充 |
| 557：回复 556，只保留金额列 | Telegram update 和接收输入均保留 `reply_to_message.message_id=556`；分类器定位对应目标，补充因原执行已结束转为基于成果的后续处理。最终 CSV 仅含销售额列与 12000、18500；文件 558、结果 559 均有 sent 回执 |
| 分类失败兜底 | 前两次输入记录 `classifier_error` 后完整交主 Bot；第三次回复定位成功。没有自动执行错误控制。不能将前两次主 Bot 完成请求算作分类成功 |
| 无说明图片 | 本轮未收到图片，真实原图兜底尚待验收；受控 bridge 测试已覆盖 |

证据包含 `inputs.jsonl`、`routing.jsonl`、持久路由决定、`outputs.jsonl`、`requests.jsonl`、`telegram-sends.jsonl` 及实际文件。写入 `STOP` 后正常关闭轮询，已确认测试 Node 进程退出。真实运行中补充、原图兜底，以及真实主 Bot 忙碌时的 helper 控制仍未完成，不能由受控测试替代。

## 最终本地验证

所有实现者已停止写入，以下检查针对最终暂存的源码、测试和配置（实现提交记录确切版本）：

- `node --import tsx --test --test-concurrency=4 test/*.test.ts`：193/193 通过，0 失败、0 取消、0 跳过。
- `npm run typecheck`、`npm run build`：通过。
- `npm run docs:check`：85 个跟踪 Markdown 的 320 个本地链接通过。
- `git diff --cached --check`：通过。

默认并发的 `npm test` 曾在多个强杀恢复子进程同时启动时超时；受影响的取消恢复与 Durable 套件独立复跑分别 1/1、10/10 通过，限制文件并发为 4 的全仓最终验证通过。没有放宽工具效果、来源身份或重复投递断言。早期两项真实回归（取消落盘到中断间崩溃、遗忘材料经路由元数据泄漏）均先失败再修复；对应强杀效果与真实模型请求断言保留。

代码评审分两轴：Standards 未发现明确仓库规范违反，保留密集表达式可读性建议；未使用的验收脚本 import 已删除。Spec 发现的两项 P1（helper 回传后目标消失、图片默认提示冒充用户原话）已由单实现者修复，审查者复核关闭，相关回归和最终全仓验证通过。

当前仅有本地实现与上述验收，未推送、未部署；规格及综合验收 Issue 保持打开直至真实链路缺口补齐。
