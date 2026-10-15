# 持久队列与主 agent 真实链路测评（2026-10-16）

规格 [#201](https://github.com/CxHsin/nailong-bot/issues/201)，接续[受控综合验收](durable-assistant-acceptance-20261015.md)。本轮使用真实模型、Telegram 手机客户端与真实 herdr Codex；队列时序和崩溃边界由测评脚本控制，具体来源分别注明。

结论：下列实测用例通过。用户确认手机收到文件，内容和显示正常。主助手两次强杀恢复分别验证了已确认工具效果复用、排队输入保留，以及外部 helper 原身份接回。本轮没有修改运行时源码、配置或凭据。

## 受检环境与证据

- 分支：`development`；受检 HEAD：`709f758`，运行时实现来自 `3ae5b92`。
- Windows 本机，Node.js `v24.15.0`，Pi Durable `1.2.0`，herdr `0.8.2`。
- 默认真实模型：`ds / deepseek-flash / openai-completions`；另验 `gpt / gpt-6.1-sol / openai-responses`。
- Telegram：`@NibHsinBot`，真实 grammY long polling，启动时没有 webhook 和待处理更新。
- 真实 helper：Codex `0.162.0-alpha.17.2`，实际显示 `GPT-6.1-Sol high`，继承 CLI 默认配置。
- 独立测试数据与工作目录：`C:/Users/Cx/AppData/Local/Temp/nailong-real-20261016-4vWOrt`。下文证据文件均相对此目录，保留在本机，未提交原始数据库或凭据。

实测发生于 Asia/Shanghai 2026-10-16 凌晨；原始日志中的 UTC 日期为 2026-10-15。临时脚本使用正式 `createAssistant`、队列、Durable 和 Telegram 连接器，数据空间与常规运行数据隔离。

## 实测结果

| 用例 | 输入与实际观察 | 证据 |
| --- | --- | --- |
| 默认模型 | 真实 DeepSeek 经 Assistant Service 与 Durable 返回 `REAL_DEFAULT_OK` | `default-result.json`、`default-data/` |
| 手机入站与文件交付 | 用户从 Telegram 发来 LIVE201 指令，真实入站消息 509；创建 `telegram-live.txt`，内容为“持久队列真实测试成功”；文件回执 510、正文回复 511 均 sent；用户确认收到且显示正常 | `inbound.jsonl`、`outputs.jsonl`、`service-data/telegram-sends.jsonl`、`work/telegram-live.txt` |
| FIFO、合批与 steer | 测评接口注入 A，实际 bash 等待显式放行；A 运行中接收 B、C 与显式 steer。放行后 A 日期从周一变为周四，B、C 成果均保留；数据库确认 A 独立批次，B、C 同属下一批次 | `queue-driver.mjs`、`queue-result.json`、`injected.jsonl`、`service-data/queue.sqlite`、`work/queue-*.txt` |
| 已确认效果与输入强杀恢复 | 真实模型调用 bash 追加一次效果；确认下一模型请求携带工具成功结果后，截住该请求，持久接收 B、C 并强杀。重开同一存储，未重发原输入；效果仍为 1 次，B、C 各自产生成果 | `crash-driver.mjs`、`crash-worker.mjs`、`crash-result.json`、`crash-data/`、`crash-work/` |
| helper 原身份恢复与独立验收 | 真实 Codex 工作时强杀主助手；重开后继续观察同一 helper，没有重新派发。主助手仍能回答无关用户输入，helper 完成后读取产物并实际复跑测试，输出 `HELPER_VERIFIED` | `helper-before-restart.json`、`helper-after-restart.json`、`helper-tool-evidence.json`、`internal-results-evidence.json`、`work/helper/` |
| reset 屏障 | 真实模型先记住合成暗号；执行 `/reset` 后立即排入检查输入，返回 `RESET_REAL_EMPTY`，没有带入旧暗号 | `reset-model-result.json`、`outputs.jsonl` |
| gpt 兼容与切换 | 独立真实请求返回 `REAL_GPT_OK`；主服务同会话 `/model gpt` 后返回 `MODEL_SWITCH_REAL_OK` | `gpt-result.json`、`reset-model-result.json` |

普通消息 B、C 和控制命令通过本地测评接口注入，不声称来自手机。队列用例中的等待脚本仅控制输入到达时机，实际模型、Shell 和文件操作均真实执行；合批没有固定等待时间窗。

### 强杀恢复边界

工具效果用例中的透明代理转发真实 DeepSeek 响应，没有伪造模型输出。代理观察到工具确认结果后，在下一请求送往上游前暂停，随后强杀 worker。原进程 PID `31092`，恢复进程 PID `24200`；效果计数为 `1`，恢复文件分别为 `B_SURVIVED` 和 `C_SURVIVED`。代理记录 9 次入站、8 次上游转发，其中一次在强杀边界截住；这些包含正常工具规划请求，不是模型重试次数。

该用例验证进程故障注入后的恢复，没有模拟上游自然宕机，也不证明未知外部效果可以自动撤销。

### herdr 接回与验收

测评执行器通过 [herdr-workflow](../.agents/skills/herdr-workflow/SKILL.md) 派发一次真实 Codex 任务。主助手实际调用 `herdr_watch` 保存身份；本用例验证观察与接回，不声称主助手自动完成了初始派发。

正式核对会话为 `live-helper201-confirmed`，原身份为 `default / live201-codex / wH:p1 / wH`，登记 ID 为 `call_00_EqyVSMCzhXtypg4xHUCN9978`。主助手 PID `32108` 强杀后，Codex 和等待脚本仍在运行；同一数据重开为 PID `22596`，保留原登记 ID。期间输入“1+1等于几”，主助手回复 2，没有改写或转交 helper 任务。

放行后 Codex 生成 `sum.mjs`、`sum.test.mjs` 和 `report.md`，两个测试分别检查 `2+3=5`、`-2+2=0`。helper 自测 2/2，通过后主助手读取实际产物并复跑 2/2，保存 `main-verification.txt`；测评执行器再次独立运行 `node --test sum.test.mjs`，2/2 通过。Durable 工具记录确认主助手实际调用了 `read` 与 `bash`，没有只转述 helper 自评。

恢复后原登记为 `delivered=true`，正式核对会话恰有一项 `done:8` 内部回传。准备阶段另有 `live-helper201` 会话，不能将正式用例的一次回传扩展为整个数据库只有一次登记或回传。

准备阶段出现两项本机问题并已修正：

1. herdr pane 未继承桌面 Codex 的 PATH，首次启动超时。核对终端后，仅在本次 pane 加入已安装 CLI 所在目录，重试后就绪，没有修改永久 PATH 或全局配置。
2. `agent prompt --wait --until working` 超时，完整 prompt 尚停留输入框。确认未提交后补一次 Enter，随后观察到实际处理和等待脚本启动，没有重发整段 prompt。准备会话曾提前观察到 idle；主助手检查实际文件后确认尚无成果，没有把 idle 当作任务成功。

## 收尾与验证范围

实测结束后，测试 bot 服务通过 `/close` 正常关闭，进程退出码 0。关闭本次 `wH:p1` 后复查，测试 Codex、pane Shell、helper 等待脚本和测试服务进程均已退出；原有 `wB`、`wC`、`wF` 保留，共享 herdr 服务仍运行。证据见 `cleanup-result.json`，helper 终端记录见 `helper-terminal.txt`。

本轮结果补充此前全仓 128/128 的受控测试，未将所有受控场景重新做成真实联调。本轮未覆盖真实图片入站、Telegram 自然断线后的未知交付、真实上游连续故障耗尽重试、高优先级后台抢占；这些行为的现有证据仍以受控验收记录为准。cron、邮件和 Slack 连接器仍在本次实现范围之外。

本报告及验收导航更新后，`npm run docs:check` 通过（77 篇跟踪文档、231 个本地链接），`git diff --cached --check` 通过。仅修改文档，不重复执行源码未变的全仓测试。
