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

### 真实主 Bot 忙碌时的完整链路补测

继续验收时，通过实际 `createAssistant.receive`、真实持久队列和 Durable，使用主模型 `ds`、独立分类别名 `gpt`（默认 8 秒）及真实 herdr，在专用 workspace `wP`、pane `wP:p1`、helper `routing-service-2247` 进行了两组输入。主模型实际调用 `herdr_watch` 登记 helper，并实际调用 `acceptance_hold` 保持主工具运行；没有替换模型或 herdr 响应。

两组均未通过及时控制验收：首组补充在约 6.2 秒返回 `invalid_result`，第二组缩短原文并明确 `replyToInputId=register` 后仍在 8 秒超时；自然语言取消均返回 `invalid_result`。主工具保持期间没有 herdr prompt 发送回执或 `adoption.json`。原文均保留并排队，释放主工具后主模型如实说明尚未补充或停止，不能算作控制成功，也没有对未知发送盲目重试。

两驱动正常关闭后，由验收者向该 helper 发送 Escape，再按保存的 PID、启动时间及命令行核对并清理 heartbeat PID 28688。独立检查确认进程消失、心跳文件 14,210 字节在两秒内不再增长；这是人工清理，不能作为应用取消成功。共享 herdr 服务和故障现场保留。完整输入、路由、真实模型指标、CLI 回执及清理证据见 `C:/Users/Cx/AppData/Local/Temp/nailong-routing-service-herdr-live-20261016-224735/REPORT.md`。

随后仅做一组 `ds` 分类对照，保持默认 8 秒及 1,024 输出 token，使用新目录和专用 workspace `wQ`、pane `wQ:p1`、helper `routing-ds-2255`，主模型仍为 `ds`。该别名此前已在 Telegram 运行中补充成功，故用于核对完整 helper 链路；没有修改生产配置或替换外部响应。

| UTC 时间 | 真实效果 |
| --- | --- |
| 14:57:49.269 | 主模型已实际登记 helper，随后实际进入 `acceptance_hold`；收到明确回复登记输入的补充 |
| 14:57:52.149 | 分类约 2,874 ms 返回有效 supplement，定位目标 `22e37749-760d-45aa-aec0-b3e61ed84114:0` |
| 14:57:52.193 | 真实 herdr prompt 提交稳定动作 `30300c4f-40fa-4a31-9ec1-a77cab42f244:0`，只发送一次；此时仅确认 sent |
| 14:58:02.258 | 独立读取 helper 实际写入的 `adoption.json`，动作、目标及原文匹配；主工具仍未释放。这补齐了真实主 Bot 忙碌时的及时转交与实际采纳证据 |
| 14:58:04.813 | 新收到的自然语言取消约 2,550 ms 返回有效 cancel；14:58:06.184 真实 Escape 及进程核验后如实返回 unknown |
| 14:58:12.830 | 最后才释放主工具，后续主模型核实心跳子进程仍在运行，没有报告已停止 |

本组登记输入分类因 HTTP 200 响应 `finish_reason=length`、内容为空而兜底，1,024 输出 token 被推理耗尽；无关慢请求分类的 JSON 含 request 不允许的 `target:""`、`candidates:[]`，整体校验拒绝并保留原文。临时驱动记录了实际响应正文和状态，没有保存凭据或请求头。这些属于模型输出协议失败，不能算全部分类成功，也不由此推导总体准确率。

应用取消未能确认孤儿心跳停止，验收者按 PID、启动时间和命令行精确核对后清理 PID 15000；进程消失、心跳文件 3,850 字节两秒稳定。人工清理仍不算自动停止成功。驱动正常关闭，共享服务保留。完整报告、模型响应、真实投递、采纳文件和清理证据见 `C:/Users/Cx/AppData/Local/Temp/nailong-routing-service-ds-live-20261016-225545/REPORT.md`；前两组失败记录保留，不继续重复试跑。

### 可核实前台任务的真实停止与无关进程对照

用户继续评测后，针对此前未能确认归属的孤儿进程，新增一组保持实际父链的前台任务对照。受检源码为 `5e6b79a`，实际主模型及独立分类均为 `ds`，分类保持默认 8 秒和 1,024 输出 token；使用真实 `createAssistant`、Durable、herdr 及默认 `helperProcesses`，没有注入进程清单或将 `complete` 改成 true。专用 workspace `wR`、pane `wR:p1`、helper `routing-foreground-2309`。

| 北京时间（2026-10-16） | 真实效果 |
| --- | --- |
| 23:11:38.389 | 主模型实际进入无关慢工具 `acceptance_hold`；前台 Node PID 19340 的真实父链为 PowerShell 1468 → Codex 6572，任务心跳与独立无关 sentinel 均在增长 |
| 23:11:39.040 | 默认进程核查实际返回候选 1468、19340 的启动时间及命令行，保留 Codex 根及基础设施；历史关系不完整，仍为 `complete=false` |
| 23:11:42.302 | 自然语言“停止前台心跳验收。”带回复登记输入的关系，实际分类约 1,746 ms 返回有效 cancel，定位目标 `827af729-d9fb-4919-9136-b0577a678617:0` |
| 23:11:43.004–23:11:44.257 | 真实 Escape 回执后，默认应用取消流程执行逐 PID 停止并复查；任务心跳最后一条为 23:11:44.018，Node 19340 与父 Shell 1468 均已消失，心跳 1,092 字节跨采样稳定。未人工终止本轮任务进程 |
| 同期无关对照 | sentinel PID 30936 的启动及命令身份未变，取消后心跳 7,364→7,462 字节继续增长；共享 herdr running/compatible、Codex 根保留，没有误杀该对照进程 |
| 23:11:50.318 之后 | 最后才释放主工具；主模型对 helper 回传进行只读核查，确认任务 PID 不存在及心跳已停止，没有重新派发或复活取消目标 |

本组证明默认应用取消整体（Escape 与默认逐 PID 停止）使可确认归属的真实前台任务停止。未分别记录每次 Kill 时刻，不能分离 Escape 与 stop 各自的贡献。默认进程核查不能排除历史孤儿，运行时仍保守报告 unknown；独立确认本轮任务已停止不等于系统已证明全部历史任务停止。此前孤儿场景的失败与人工清理限制保留。

登记输入分类再次出现 HTTP 200、`length`、空内容（1,024 token 用于推理），原文安全兜底后由主模型完成实际登记；无关慢请求和取消分类成功，不能称所有请求均分类成功。驱动于 23:12:11.517 正常关闭。整理报告的代理会话随后发生模型服务 404，主会话接手精确核对并清理自有 sentinel，确认本轮任务进程仍不存在、心跳仍为 1,092 字节；未通过人工任务清理制造停止成功。

完整报告及实际父链、CLI、进程、活动和无关对照证据位于 `C:/Users/Cx/AppData/Local/Temp/nailong-routing-foreground-live-20261016-230908/REPORT.md`，主会话收尾见 `controller-cleanup.json`。本次未修改运行时代码或生产配置，共享服务和未知状态的 pane 现场保留。

### 用户指出后的退出与 workspace 收尾

用户指出 workspace 累积及 `/exit` 退出方式后，重新核对 [herdr 工作流第 4 节](../.agents/skills/herdr-workflow/SKILL.md)：保存成果及证据后应关闭本任务 pane/workspace。此前任务进程已核验并清理，仍以保留故障现场为由持续保留四个测试 workspace，属于验收收尾不完整；保留日志不要求持续占用活动 workspace。

向仍处于空闲状态的三个 Codex helper 输入 `/exit` 并实际提交后，终端回到 Shell，原 Codex PID 22916、31480、6572 均消失，`herdr agent list` 为空。随后关闭本轮专用 workspace `wN`、`wP`、`wQ`、`wR`，回执均成功；最终 workspace 列表仅余原项目 `wB`（nailong bot），共享服务 running/compatible。日志、会话恢复标识和成果仍保存在原临时目录，退出及关闭证据另存 `C:/Users/Cx/AppData/Local/Temp/nailong-routing-workspace-cleanup-20261016/`。

此前测试的是 Escape 中断轮次，没有测试 `/exit` 对仍在运行的脱离父链任务的影响。因此旧孤儿结果不能推出 `/exit` 也无法清理，更不能把中断轮次与结束整个 helper 混为同一失败。当前实测证明 `/exit` 能正常退出这三个 helper；该步骤发生时测试后台任务已清理，不额外宣称证明了任意 detached 子进程的退出。后续整项 helper 结束优先正常退出并关闭 workspace，单轮取消保留其独立语义，不为本轮收尾新增通用进程追踪系统。

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

证据包含 `inputs.jsonl`、`routing.jsonl`、持久路由决定、`outputs.jsonl`、`requests.jsonl`、`telegram-sends.jsonl` 及实际文件。第二轮写入 `STOP` 后正常关闭轮询，已确认测试 Node 进程退出。

### 第三轮：运行中补充与无说明图片

用户继续授权真实评测后，在独立目录 `C:/Users/Cx/AppData/Local/Temp/nailong-routing-telegram-live-20261016-r3/` 运行相同主模型与分类别名 `ds`，分类仍采用默认 8 秒超时。验收工具最多保持 90 秒，进入真实工具边界时由 Bot 通知用户；外部 `RELEASE` 文件只用于在确认补充已提交后释放工具，不替代实际分类或补充消费。

| 真实消息及行为 | 结果与证据 |
| --- | --- |
| 561：生成 `live-report.md` 并先等待 | 14:48:41.990Z 收到；初次分类 `classifier_error`，原文安全兜底。实际报表工具 14:48:52.674Z 进入等待 |
| 562：改 CSV，文件名 `live-report.csv` | 14:48:52.787Z 收到，原工具仍在运行；真实分类得到 supplement，定位消息 561 的稳定目标。动作 `6fff3b80-2e55-438e-b589-ff301d546fc4:0` 提交至 Durable submission 15，补充消费记录最终为 handled |
| 工具正常结束后交付 | 14:49:34.823Z 原工具正常退出，没有因普通补充被中断；首次写入即为 `live-report.csv`，未生成旧版 Markdown。文件含月份与销售额两列、12000 和 15000 两行数据；文件消息 564、结果消息 565 均有 sent 回执 |

这次补齐了真实 Telegram 运行中补充及交付证据；首次请求分类失败仍单独保留，不将主模型兜底成功算作分类成功。`boundaries.jsonl`、`routing-decisions.json`、Durable 日志、`telegram-sends.jsonl` 和实际 CSV 可以相互核对原文、目标、消费及交付。

提交 `2c0f892` 时轮询仍在等待图片。随后用户发送无 caption 照片消息 567，于 2026-10-16 23:03:35.980（北京时间）收到，完成以下核验：

| 图片链路 | 真实证据 |
| --- | --- |
| 接收与路由 | Telegram update 无 caption；持久输入 `userText=""`，分类快照当前正文为空、`hasImages=true`，直接记录 `needs_visual` 兜底，没有将默认提示作为用户路由意图 |
| 原附件与模型材料 | 下载 Telegram 提供的最大照片版本：JPEG，1280×853，128,926 字节。Durable 主模型输入 entry 28 保留空用户事件，默认提示单独标注“不是用户原话”；图片与下载后持久输入的 SHA-256 均为 `dffc19e38fdc4f1e369d221dee5dcd0e387d41208b9b6b70a665270c348b4946`，逐字节一致 |
| 实际回答与交付 | 主模型 `ds` 实际视觉请求约 5,237 ms 完成，描述人物背影、百叶窗光影、床铺及相机等，与验收者独立查看附件相符；未将照片解释为 CSV 修改。结果消息 568 有 sent 回执 |
| 正常收尾 | 核对交付后写入 `STOP`，测试进程正常退出（exit 0），核查原测试 PID 9072 已不存在，没有启动第二轮询器 |

照片证据位于同目录 `photos.jsonl`、`photo-evidence.json`、`photo-567.jpg`、原始 update、Durable 记录、模型请求指标及发送回执。这里的附件一致性指 Telegram 实际交付的照片版本，不对 Telegram 上传前的文件作推断。真实原图兜底及本轮 Telegram 验收已完成；helper 孤儿进程的自动停止仍无成功证据，按前文保留 unknown 与人工清理限制。

本次仅修改真实验收脚本及本文。脚本独立严格 TypeScript 检查通过；`npm run docs:check` 的 85 文档、320 本地链接通过，`git diff --check` 通过。下文 193 项全仓测试及构建结果适用于实现提交 `8370915`，本次未修改运行时代码，不重复计为新一轮全仓验证。

## 最终本地验证

所有实现者已停止写入，以下检查针对最终暂存的源码、测试和配置（实现提交记录确切版本）：

- `node --import tsx --test --test-concurrency=4 test/*.test.ts`：193/193 通过，0 失败、0 取消、0 跳过。
- `npm run typecheck`、`npm run build`：通过。
- `npm run docs:check`：85 个跟踪 Markdown 的 320 个本地链接通过。
- `git diff --cached --check`：通过。

默认并发的 `npm test` 曾在多个强杀恢复子进程同时启动时超时；受影响的取消恢复与 Durable 套件独立复跑分别 1/1、10/10 通过，限制文件并发为 4 的全仓最终验证通过。没有放宽工具效果、来源身份或重复投递断言。早期两项真实回归（取消落盘到中断间崩溃、遗忘材料经路由元数据泄漏）均先失败再修复；对应强杀效果与真实模型请求断言保留。

代码评审分两轴：Standards 未发现明确仓库规范违反，保留密集表达式可读性建议；未使用的验收脚本 import 已删除。Spec 发现的两项 P1（helper 回传后目标消失、图片默认提示冒充用户原话）已由单实现者修复，审查者复核关闭，相关回归和最终全仓验证通过。

当前仅有本地实现与上述验收，未推送、未部署；规格及综合验收 Issue 保持打开直至真实链路缺口补齐。
