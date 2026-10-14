# 原生 Pi 实机测试补充（2026-10-14）

基准 `e0b78b994349d46518ec429f7a80e17d1e30e428`，development；规格 [#196](https://github.com/CxHsin/nailong-bot/issues/196)、实施 [#197](https://github.com/CxHsin/nailong-bot/issues/197)。本次用户明确要求“开始进行真实测试”，包含向配置的 Telegram 主人实际发送测试文件与消息。

## 入口与配置

正式 `src/main.ts` 在后台运行，PID 24936，实际 bot `@NibHsinBot`。`getMe` 成功，`getWebhookInfo` 确认无 webhook、启动时 pending=0；未发现另一 bot 入口进程。

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

真实 Telegram 文件与编码闭环已通过；真实图片入站待补充；服务重开采用正常关闭而非真实进程崩溃，本轮不声称完成进程死亡矩阵。Claude ds 的 402 已由用户确认，本次未更改配置或重复尝试，成功 Claude 编码仍未完成。#196/#197 保持开放，不以 Codex 结果替代 Claude 验收。

正式 bot 保持运行，供用户继续私聊实测。只停止该测试 bot 的 PowerShell 命令为 `Stop-Process -Id 24936`，执行前核对该 PID 仍对应本次 src/main.ts。停止 bot 不停止外部帮手。专用 Codex/pane 与 herdr session 保留现场，本次合成后台任务已实际停止。
