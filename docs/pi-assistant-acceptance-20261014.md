# 原生 Pi 主助手验收（2026-10-14）

规格 [#196](https://github.com/CxHsin/nailong-bot/issues/196)，任务 [#197](https://github.com/CxHsin/nailong-bot/issues/197)。实施基准 `727a294293463332e55558fa3e5ba518719d6890`，development。当前入口为原生 Pi + Telegram/CLI 接入 + herdr-workflow；旧 Host 证据不能替代本轮运行结果。

## 自动化边界

测试使用真实应用入口、Pi Session/工具/资源加载器，本地模型 HTTP 与 Telegram API 替身。受控模型输出证明机制，不代表真实模型自主路由的质量。

| 用例 | 实际检查 |
| --- | --- |
| assistant-runtime | 原生工具写入真实文件、正常回复、会话重开、输入去重、第二进程拒绝；skills/扩展发现与工具错误；后台交流；运行中重启自动观察、正确会话回传及已知回传不重复；排队回传未持久呈现时重启后接回；reset 跨查询不注入旧会话；首个回复前的磁盘状态恢复不丢结果；可见结果后立即 reset 不重复注入 |
| assistant-interaction | 当前工具轮次的 steering 进入下次模型请求；实际 compaction 保留要求且不加载合成旧数据；reset 后立刻重启不泄漏旧上下文；文件内容交付 |
| assistant-herdr-interaction | 受控模型读取实际 skill，通过原生 Shell 调用本地 CLI 替身；只转交明确补充要求，无关交流不转交；未知停止如实回复；错误身份被拒绝并交回主模型 |
| assistant-telegram | 主人身份、重复输入、富文本、图片进入模型、实际 sendDocument 调用、400 格式降级、未知发送不自动重发与回执 |
| assistant-cli | 实际正式 CLI 子进程：数据目录独占、连续启动重开保存会话、JSON 交付 |
| telegram-rich-reply | 原有格式分页、正文预览与草稿发送边界 |

综合检查：`npm test` 88/88 通过（其中新入口 17 个行为测试），`npm run typecheck`、`npm run build`、`npm run docs:check` 通过。完整测试日志 `C:/Users/Cx/AppData/Local/Temp/nailong196-final-test.log`。排队回传的修复用例在删除启动时未回执 notice 清理后会丢失回传；reset 指针用例在删除指针选择后会恢复旧上下文。双向评审发现的 reset 会话归属、内存回执和已知回传重置问题均已修复，新增 3 个回归；详见 [评审记录](pi-assistant-review-20261014.md)。

## 真实模型和外部 CLI

本轮使用系统临时目录，只读或修改合成材料；配置未改写，未向真实 Telegram 用户发送消息。以下证据为此设备本地文件，未提交凭据、会话数据库或原始终端日志。

- 原生 Pi 使用已配置 `gpt` 端点，在 `C:/Users/Cx/AppData/Local/Temp/nailong196-live-gpt/` 创建 `result.txt`，内容 `lotus-196`；通过原生 bash 读回并正常回复。`transcript.json` 保存模型对话输出，原生 JSONL 的实际工具结果另提取为 `tool-evidence.json`。
- herdr 专用 session `nailong196-probe`，Codex agent `inspect196`，模型 `GPT-6.1-Sol low`，CLI 参数 `--sandbox danger-full-access --ask-for-approval never --no-daemon`。只读成果 `C:/Users/Cx/AppData/Local/Temp/nailong196-acceptance/codex-report.md`；代码成果 `C:/Users/Cx/AppData/Local/Temp/nailong196-codex-code/` 的 `sum.mjs`、`sum.test.mjs`、`report.md`。主助手独立运行 2 个测试（空数组及正负混合），2/2 通过。
- 原生 Pi + `herdr_watch` 实际登记上述 Codex、后台接回结果，由 Pi 读取真实代码与报告、执行测试，2/2 通过。证据 `C:/Users/Cx/AppData/Local/Temp/nailong196-live-codex-return/transcript.json`。该目录 `tool-evidence.json` 从原生 Session 提取 read/bash 实际工具结果。完成文字只用作脚本退出信号；验收依据实际文件和命令结果。
- Claude Code v2.1.296，agent `claude196clean`，`--permission-mode auto`，实际模型 `deepseek-v4-flash max`。完成专用目录信任后请求返回 HTTP 402 Insufficient Balance，没有形成代码产物。用户确认该 ds 账户无额度是正常情况，保持原设置，不算成功代码验收。
- 主 Pi 默认 `ds` 的直接试验同样返回 402；仅本次验收显式选择现有 `gpt` 别名，没有改动默认模型或 Claude 配置。

可复用真实模型入口：`node --env-file-if-exists=.env --import tsx scripts/acceptance/assistant-live.ts OUTPUT_DIRECTORY PROMPT_FILE [MODEL_ALIAS]`。输出目录应在仓库之外；marker 不是成果验收。

## 未验证及限制

真实 Telegram 手机端完整往返、真实模型的编码期间插话/补充/停止/重启完整矩阵，以及 Claude 实际代码成功仍未验证；自动化替身覆盖不能替代这些项。新版入口已切换，可运行代码和回归已交付，但 #196 的完整真实验收矩阵仍有以上缺口，保持 Issue 开放。上线使用前按实际账户条件补齐。

输入先去重再执行，崩溃可能丢失未完成输入；帮手恢复只对账并恢复观察，不保证自动完成所有工作或跨系统 exactly-once。发送结果未知不重发。旧数据未读取、迁移或自动删除。正式操作见 [操作说明](personal-agent-operations.md)。

本任务 Codex 成果与终端证据保存后，核对专用 pane w1:p1 身份并关闭，agent 查询返回 not_found，本机无对应 Codex CLI 进程。Claude 402 的 pane 与专用 herdr session 保留现场；未停止 herdr 主服务。
