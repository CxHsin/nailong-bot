# 原生 Pi 实机测试补充（2026-10-14）

> 历史实机记录：以下 PID、会话路径、模型与发送证据仅说明记录时现场，不表示当前仍运行。新队列与 Durable 入口见 [操作说明](personal-agent-operations.md)、[当前验收](durable-assistant-acceptance-20261015.md)；保留原实测结论及限制。

基准 `e0b78b994349d46518ec429f7a80e17d1e30e428`，development；规格 [#196](https://github.com/CxHsin/nailong-bot/issues/196)、实施 [#197](https://github.com/CxHsin/nailong-bot/issues/197)。本次用户明确要求“开始进行真实测试”，包含向配置的 Telegram 主人实际发送测试文件与消息。

## 入口与配置

首次实测时正式 `src/main.ts` 在后台运行，PID 24936，实际 bot `@NibHsinBot`。`getMe` 成功，`getWebhookInfo` 确认无 webhook、启动时 pending=0；未发现另一 bot 入口进程。该进程后来退出；晚间恢复和当前运行信息见下文。

本次进程选已配置 `gpt`，使用独立数据与目录：`C:/Users/Cx/AppData/Local/Temp/nailong196-telegram-live-20261014-170710/`。`.env`、默认主模型 ds、Codex 与 Claude 全局配置未修改。Windows Node v24.15.0；实际 Codex v0.162.0-alpha.17.2，GPT-6.1-Sol low，`--sandbox danger-full-access --ask-for-approval never --no-daemon`。

## 实际结果

| 项目 | 运行和核对结果 |
| --- | --- |
| 主人 Telegram 入站 → Pi → 文件与回复 | 用户按提示在 Telegram 发送 hello.txt 请求；正式主进程原生 JSONL 中存在该输入，实际工具为 write/read/send_file。hello.txt 内容为“新版 Pi 测试成功”；文件 message_id=492，正文回执 491/493。用户回复“正常”，确认客户端显示与文件收到 |
| 实际文件、富消息出站 | 另一独立 Pi Session 经正式 connectTelegram 接入，实际 write/bash/send_file；telegram-test.txt 内容为“原生 Pi → Telegram 文件交付测试成功”，Telegram 文件 message_id=487，富文本结果 message_id=489。API 接受，接入 errors=[]。这项输入来自本地脚本，不能算手机入站 |
| Telegram 发起完整编码闭环 | 用户随后在 Telegram 发送 telegram-code 请求，正式主 Session 自动建专用 session telegram-sum-1721、workspace w2/pane w2:p1，启动 sum-codex；实际读取 skill、发送完整文件 prompt 并登记 herdr_watch。Codex 生成 sum.mjs 和 sum.test.mjs，正整数相加及负数/零恰好 2 个测试通过。主 Pi 通过 bash 读回文件、再次运行 2/2，保存 verification.txt；完成材料有对应 custom_message 磁盘回执，最终汇报 message_id=499 已 sent。执行负责人独立运行同一测试 2/2 通过 |
| 主 Pi 派发真实 Codex | 主 Pi 读取项目 herdr-workflow、查询真实 agent、调用 PowerShell 文件 prompt 脚本，确认接收后 herdr_watch。专用 session nailong196-probe，agent matrix196，workspace w4，pane w4:p1，工作目录为 testing-root/coding-matrix |
| 后台无关交流 | helper 工作期间，主 Pi 收到明确无关的“1+1”问题，直接回复“2。”；未把它发给 Codex。原生工具记录与终端显示只有实际初始任务和补充要求 |
| 补充要求 | 主 Pi 实际转交 multiply(a,b) 与两个测试，Codex 终端明确确认收到。最终 math.mjs 导出 sum 和 multiply；math.test.mjs 包含空数组、正负混合、3×4、0×7 四个用例，实际 node --test 4/4 通过 |
| 重开与回传 | 主 Pi 服务 close/createAssistant，沿用同一原生 Session、数据与实际帮手，没有再次 agent start 或重发原任务；补充任务完成材料有对应身份的 custom_message 磁盘回执。回传与显式复核输入在同一会话排序；独立读取代码、报告并实际运行测试 4/4。由于脚本在报告出现后也发送了显式复核输入，本项证明重开后关联/接回与检查，不声称整个时段完全没有其他输入 |
| 明确停止 | 主 Pi 向 matrix196 派发另一个合成任务，实际运行 node stop-gate.mjs，PID 5668。停止请求后发送 Escape，中断 Codex 轮次；主 Pi 独立发现 Node 仍活着，核对命令行与启动时间后只终止该测试 PID。两次查询确认不存在，间隔 2 秒心跳值均为 1791969541381；执行负责人再次查 PID 不存在，after-stop.txt 未生成。Codex PID 27756 与 herdr 主服务保持存活，其他工作与已有成果未删除 |

## 实机暴露的行为

herdr 的 `agent prompt --wait` 在本机可能超时而文本仍在编辑器。主 Pi 实际查 get/read 确认内容，补一次 Enter 后确认 working，没有重复整个 prompt。初始派发、补充和停止任务均保留对应文件与终端记录。Telegram 编码链路首次 agent start 遇到 pane 找不到 codex，主 Pi 自行读取终端、where.exe/codex --help，查得真实可执行路径，只修改该 pane 的 PATH，并使用 --no-daemon 恢复。专用 session 初启也出现过 server_not_running，查询后继续成功，未重复创建代码任务。

本轮 gpt 与 Codex 都出现过 HTTP 429。Telegram 输出会话出现实际限流错误提示后仍完成文件及富文本交付；Codex 初始轮次以 429 中断，保留已写文件与门控命令。主 Pi 没把 done 当成功，核对当前工作并将新补充任务登记观察；Codex 后续处理补充要求，最终检查通过。不能把本轮结果表述为全程无错误或限流不会影响执行。

Escape 不会必然停止 Codex 已启动的后台进程。本次主 Pi 通过 PID/命令行/心跳核对并终止准确进程，才判断当前合成工作已停止。此例不承诺任意外部进程树都可自动停止。

## 证据与覆盖范围

原始凭据、会话与终端日志不提交仓库。以下为此设备本地证据：

- testing-root `bot.out.log`、`bot.err.log`、`pi-data/telegram-sends.jsonl`、`telegram-inbound-tool-evidence.json`、`hello.txt`。
- `telegram-outbound/telegram-sends.jsonl`、`telegram-test.txt`、`tool-evidence.json`：真实 API 回执、实际工具与文件。
- `telegram-code-terminal.txt`、`telegram-code/task-prompt.txt`、`telegram-code/sum.mjs`、`telegram-code/sum.test.mjs`、`telegram-code/verification.txt`，以及正式 Pi 原生 JSONL 与 telegram-inbound-tool-evidence.json：真实 Telegram 发起编码及主助手独立检查。
- `coding-matrix/transcript.json`、`tool-evidence.json`、`helper-prompt.txt`、`supplement-prompt.txt`、`restart.finished`、`math.mjs`、`math.test.mjs`、`report.md`。
- `coding-matrix/stop-transcript.json`、`stop-result.json`、`stop.pid`、`stop-heartbeat.txt`、`before-stop.txt`：真实停止及保留的已有影响；after-stop.txt 不存在。

测试根目录是上文完整绝对路径。编码矩阵输入来自真实本地应用入口与真实模型，Telegram 文件测试输入来自真实用户；这些是不同实机用例，不能称所有编码阶段都由手机发起。通过记录新增实机证据，本次没有修改实现源码；前次综合自动化仍为 88/88，见 [原验收与复核](pi-assistant-acceptance-20261014.md)。

首次实测完成时，真实 Telegram 文件与编码闭环已通过；真实图片入站待补充；服务重开采用正常关闭，尚未测试强制终止。Claude ds 的 402 已由用户确认，未更改配置或重复尝试。晚间新增覆盖如下。

## 晚间验收：默认 session、进程死亡与重试出站

基准 `70ae22c9cfbd38a5b76656ded8ee8b10bc77c1a6`。旧 bot PID 24936 已退出，其旧日志存在 Telegram `getUpdates` 409 冲突；本机未发现另一入口进程。19:23 恢复正式入口为 PID **34100**，沿用首次实测的数据与工作目录，再次核对 getMe、无 webhook 和 pending=0。新进程日志未出现该冲突，只记录 TELEGRAM_* 配置别名提示。主模型仍仅在测试进程选择现有 gpt，未更改 `.env` 或 CLI 全局配置。

| 项目 | 运行和核对结果 |
| --- | --- |
| Telegram 发起默认 session 编码 | 用户发送 acceptance-default 请求，正式 Pi 输入时间为 19:25:02。主助手复用默认 herdr session，创建 wF/wF:p1、agent acceptance-double-codex，实际派发 Codex 并登记 `herdr_watch(session=default)`。prompt 超时后查实际输入，补一次 Enter，再核对 working；未重复发送任务。Codex 创建 double.mjs 与恰好两个 node:test（正数、负数与零），自身 2/2；主 Pi 读回实际文件并独立运行 2/2，保存 verification.txt；执行负责人独立复跑 2/2。后台登记和最终汇报等 message_id=501–504 均 sent；用户确认收到且显示正常 |
| 主助手强制终止后接回 | 使用独立真实 Pi 进程和真实 Codex，默认 session、wE/wE:p1、agent crash196-192619。Codex 正在运行门控 Node PID 29980，主 Pi PID 22956 已登记后台观察。核对命令行、启动时间和持久化身份后强制终止主 Pi，未调用 close；确认门控和 Codex 继续工作。以同一数据重开主 Pi PID 10336，恢复后不发送新输入，再释放门控。Codex 生成 subtract.mjs、subtract.test.mjs、report.md，自身 2/2；恢复的 Pi 自动接回，读实际文件、独立执行 2/2并写 main-verification.txt；执行负责人独立复跑 2/2。原生记录恰好 1 个用户输入、1 次 herdr_watch、1 个 herdr_result 磁盘回执，帮手身份与终止前一致且 delivered=true，主 Pi 没有 agent start 或 agent prompt。此项来自本地入口，文件输出由本地订阅器保存，没有 Telegram 文件交付回执 |
| 原生重试经真实 Telegram 出站 | 真实 Pi Session 连接本地受控 Provider：首个请求 429，第二个请求成功；正式 connectTelegram 经真实 API 发送“模型限流，正在重试（1/1）。”和最终恢复结果，message_id=505/506 均 sent，requests=2、errors=[]。用户确认两条都收到、显示正常。此项证明原生重试提示和真实出站，限流由受控 Provider 注入，不代表手机输入触发真实上游 429 |
| 真实图片入站与描述 | 用户在 19:39:42 通过 Telegram 发送图片并附“描述一下图片”。正式 Pi 原生输入 id=00431fc7 包含 text 和 image/jpeg（图片数据已实际加载），gpt-6.1-sol 于 19:40 回复黄色奶龙、红褐和乳白长袍、金色光芒及小天使等画面描述。Telegram message_id=508 为 sent，回复与用户提供的客户端截图一致；用户明确确认“图片验收通过”。本次请求为图片描述，未要求生成或发送描述文件 |

本轮原始证据保留在设备本地：

- 首次测试根目录的 `acceptance-default/`：代码、测试、verification.txt、task-prompt.txt、send.ps1、tool-evidence.json；正式 Pi 原生 JSONL 和 `pi-data/telegram-sends.jsonl` 保存实际入站、工具、回传与发送回执。
- `C:/Users/Cx/AppData/Local/Temp/nailong196-acceptance-final-20261014-192510/`：forced-termination.json、main-probe.mjs、main-before/after 日志与 outputs、helper-terminal.txt、crash-tool-evidence.json、main-data 原生 Session/身份记录、代码和报告、main-verification.txt、root-verification.txt。
- 同一补验目录的 telegram-retry.mjs、telegram-retry-result.json、telegram-retry-receipts.jsonl：受控模型请求次数、原生输出、实际 Telegram 回执。
- 首次测试根目录的 telegram-photo-evidence.json：原生图片输入元数据、实际模型描述与 Session 来源；图片数据仅保留类型与长度摘要。发送回执见同目录 `pi-data/telegram-sends.jsonl`；客户端截图由用户提供并确认。

保存证据后仅终止本次恢复探针 PID 10336，关闭核对过的 wE:p1；wE 随最后一个 pane 关闭而消失，门控进程已退出。共享默认 herdr 服务、其他 workspace、Telegram 编码 wF 和正式 bot 保持运行。

## 当前结论与待验项

默认 session 编码、后台交流与补充、准确停止、强制终止后恢复观察、文件往返、重试出站与客户端显示、真实图片入站与描述均已有实机证据。完整自动化为 93/93，类型检查与构建通过，见原验收补充。Claude ds 仍受已知 402 额度限制，成功编码未验证。#196/#197 保持开放。

正式 bot 当前 PID **34100**，继续供用户私聊实测。停止前先核对 PID、命令行与启动时间仍对应本次 `src/main.ts`，再执行 `Stop-Process -Id 34100`；停止 bot 不停止外部帮手。原始凭据、数据库、图片内容和终端日志不提交仓库。
