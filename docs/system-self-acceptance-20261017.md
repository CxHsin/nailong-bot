# 系统顺序、SELF 与 Telegram 附件验收

日期：2026-10-17。实现与评审基准：`905fbff`；规格 [#234](https://github.com/CxHsin/nailong-bot/issues/234)，任务 [#235](https://github.com/CxHsin/nailong-bot/issues/235)、[#236](https://github.com/CxHsin/nailong-bot/issues/236)，追加附件任务 [#237](https://github.com/CxHsin/nailong-bot/issues/237)。本记录对应本地实现，不表示已推送、合并或重启生产服务。

受控测试沿用用户确认的 Assistant Service 集成夹具及 Telegram update 入口，模型端点和 Telegram HTTP 为外部协议替身；检查实际编码请求、真实文件与持久状态，不能据此证明模型语义。

| 保证 | 实际入口与观察 |
| --- | --- |
| 基础指令 → skills → project → SELF → MEMORY | `test/assistant-self.test.ts`：Completions、Responses、Anthropic 实际 HTTP 请求；已有会话重开采用新基础指令 |
| 多行环境文本及旧入口退役 | `test/assistant-cli.test.ts`：正式 CLI 子进程，缺失/空值在连接器前报错，旧 prompt 文件不回退 |
| SELF 权威及稳定快照 | 人工文件初始化、同轮工具续步、无变化重启沿用旧快照、人工修改后重启保留无关历史 |
| 更新、纠正、遗忘和共享 | writer/reader 两个会话，新增增量、reset 新快照、纠正与遗忘清理旧快照/工具参数/派生材料，原文保留 |
| 迁移 | 旧生成档案、人工文件、缺失但有旧有效数据库条目、新空空间；排除撤回条目、重复重开不覆盖 |
| 持久化故障 | `.tmp` 目录导致真实写入失败、运行期间人工编辑冲突；压缩后台提炼 rename 后，通过 SQLite trigger 中断元数据，重开按文件核对且不重复迁移 |
| 原生压缩与预算 | 后台从覆盖的真实用户原文提炼 SELF，压缩重开保留；SELF/MEMORY 合计预算及原件分页引用 |
| Telegram document | 鉴权、说明文字、消息去重、路径落盘、PDF 正文及文本路径、无说明文字、损坏 PDF 保留原件且显式回复 |
| 下载限额 | 同一 Telegram 入口调用真实 downloader，getFile 元数据与实际流超 20 MiB 均拒绝，模型不启动 |

保留现有记忆来源、后台学习排除、摘要重建、队列、helper 与未知外部效果测试。停止源码/夹具写入后的综合结果：`node --import tsx --test --test-concurrency=2 test/*.test.ts` 170/170 通过，`npm run typecheck`、`npm run build` 通过，`npm run docs:check` 检查 101 份跟踪 Markdown 的 418 个本地链接通过。

首轮 `npm test` 默认并发下为 167 通过、2 失败、1 取消：取消恢复超过 25 秒，首次强杀 worker 超过 10 秒并在清理 SQLite 时遇到 EBUSY。取消恢复单独重跑通过；随后全套限制两份测试文件并发，170 项全部通过，原故障点亦通过。没有放宽业务断言或超时阈值。代码评审结果见任务 Issue 与最终提交。

## 真实模型

使用 `scripts/acceptance/self-live.ts`，通过既有 `.env` 主模型配置，在系统临时目录 `nailong-self-live-e97b0c4a442d46628b89f8b3ec945bec` 创建独立数据与工作目录。原始输出、逐场景 SELF 和实际 usage 保存在该目录的 `self-live.json`，不读取生产对话，不发送外部消息，不启动 helper。

七个场景均完成：默认介绍识别奶龙及奶香小面包；明确标为历史工具输出的“改名岩石”未改变身份；表达习惯通过 SELF 写入；当前明确交办将身份 supersede 为星舟；表达习惯纠正为“先两个选项后结论”；忘记两次表达习惯来源；重启后保留星舟并确认没有指定的回答顺序偏好。

模型为 `deepseek-flash`，协议 `openai-completions`，13 次主执行请求。SDK 实报非缓存 input 合计 18476、output 合计 2006、cacheRead 合计 54912；这些是本次运行的 usage，不作改动前后收益对比。

实际最终回答节选：“当前身份是星舟：你的冷静航行助手……关于长期回答顺序偏好：当前已无。”逐场景文件同时证明写入、纠正和遗忘确实改变当前 SELF；模型的完成声称不单独作为证据。语义验收是一次真实运行，不能外推所有模型的判断质量或缓存收益。

本地 `.env` 已补充多行 `AGENT_SYSTEM_PROMPT`，凭据未改动；实际服务没有重启，生产 SELF 也未在本次测试中写入。启动升级版本时由迁移边界处理现役 SELF；操作与限额见[当前操作说明](personal-agent-operations.md)。
