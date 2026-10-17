# 旧实现与遗留数据清退验收

日期：2026-10-17。规格 [#226](https://github.com/CxHsin/nailong-bot/issues/226)，依据 [ADR-0014](adr/0014-retire-legacy-code-and-data.md)。任务 [#227](https://github.com/CxHsin/nailong-bot/issues/227)、[#228](https://github.com/CxHsin/nailong-bot/issues/228)、[#229](https://github.com/CxHsin/nailong-bot/issues/229)、[#230](https://github.com/CxHsin/nailong-bot/issues/230)。

## 受检状态

- 集成分支 development；实施前基准 3a26b29b49c18bc8801d030a07234ca66953b995，已同步 origin/main。
- 两位实现代理明确停写后，主代理在稳定源码上完成类型检查、构建与全仓测试。历史说明和本验收的文档检查另行执行。
- 原有 .archify、.scratch 和未跟踪研究文件保留；未将它们暂存或清理。

## 代码与行为

删除 49 个退休源码、13 个专用测试和 6 个无现役消费者的夹具，共 68 文件。旧日志读写、迁移、上下文投影/压缩、记忆图内核与学习、旧模型适配及旧 preview 适配不再保留。run:diagnose、context:diagnose、migrate 三个包命令退出，旧 helper 启动导入、legacyDataDir 和 ASSISTANT_LEGACY_DATA_DIR 一并移除。

当前路由仍使用 estimateInput，Telegram 仍使用 Update/ReplyMessage，构建身份仍由 build-identity 记录；这些共享能力保留。移除同模块内仅服务退休路径的预算、请求和旧 Tool Search 导出。当前依赖均仍有现役使用者，无需变更锁文件。

构建增加仅清理固定项目 dist 的 prebuild。清理目标由脚本位置解析并核对父目录，随后 tsc 重新输出；实际 dist/src/runtime 仅剩 build-identity.js，不再残留旧日志/诊断 JavaScript。现有 acceptance 脚本继续使用现役 Assistant Service/intent，保留原入口。

现役保证通过既有集成边界保留：

- [启动与 helper](../test/assistant-runtime.test.ts)：旧导入失败的锁释放保证迁移到真实队列路径初始化失败，修正后可在同进程重新启动并接收 /help；现役 helper 的原身份、重启、reset 和结果确认保留。
- [Durable](../test/assistant-durable.test.ts)：原有用例补入真实 reasoning 流与工具参数，确认它们不进入正文 preview；已确认工具效果在重试/续接中不重做。
- [记忆](../test/assistant-memory.test.ts)、[失效治理](../test/assistant-memory-invalidation.test.ts)、[上下文](../test/assistant-context.test.ts)及[归档](../test/assistant-archive.test.ts)：现役来源、纠正与遗忘、快照、压缩恢复、原件分页与检索继续验证。
- 当前 Telegram/CLI、输入路由、队列、SIGKILL 恢复及发送记录均由全仓现役回归覆盖；未启动真实模型或测试 Bot 取代生产服务。

## 实际检查

| 检查 | 结果 |
| --- | --- |
| npm run typecheck | 通过 |
| npm run build | 通过，包含固定 dist 清理与构建戳生成 |
| npm test | 142 tests，142 pass，0 fail/cancelled/skipped，69.71 秒 |
| npm run docs:check | 通过，97 份受跟踪 Markdown、393 个本地链接 |
| git diff --check | 通过 |

首轮测试与两项编译检查并发，141 项通过、1 项 SIGKILL 恢复用例在 25 秒时限取消；源码与时限未改，在编译完成后单独重跑全仓 142/142 通过。首轮与重跑日志分别为 C:/Users/Cx/AppData/Local/Temp/nailong-retirement-tests-20261017.log 和 nailong-retirement-tests-retry-20261017.log。

现有损坏 queue.sqlite 构造失败的路径另发现句柄未关闭问题，Windows 删除该损坏临时库会报 EBUSY；它未由此次清退引入，未扩展修改队列实现。资源释放回归使用不创建 SQLite 句柄的真实路径占用故障，不宣称覆盖损坏库句柄处理。

## 本地数据结果

实际运行 Node 进程 PID 36224 从本仓库 dist/main.js 启动；核对进程工作目录与允许名单中的数据路径环境变量，确认使用 data/pi-durable-v1。Restart Manager 的 40 项文件占用核对显示该进程使用现役数据库及 WAL/SHM，旧数据库未见占用。删除前再次逐项验证绝对范围、保留项不相交、无重解析点，并用只读独占文件打开检查候选占用。

清单 42 个目标全部移除，失败 0；删除前 507,910,215 字节，删除后 1,610,496 字节，共移除 506,299,719 字节，约 482.85 MiB。data 未受 Git 跟踪，删除实际发生在本机；没有新增备份或归档。

保留现役 data/pi-durable-v1、data/workspaces、根与旧 Pi 目录的 auth.json，以及两批旧备份中的 2 个 auth.json 和 1 个 env-before-handover。保留文件共 26 个，其中现役 21 个，删除前后 SHA-256 全部相同。现役 5 个 SQLite 在临时副本只读 quick_check 全部为 ok，来源、召回、快照、队列和 Durable 表均可读取，临时副本已清理。

删除脚本结束时的 PowerShell Get-FileHash 受现役 SQLite 文件共享模式影响而停止；删除动作已完成。随后用支持共享读取的 Node 核对全部目标不存在、26 个保留文件哈希未变，未重复执行删除。

prototypes/pi-mono 是无工作区修改、无 remote 未覆盖提交的上游研究 clone，按规格的旧原型范围删除；独立 workspaces 即使为空也保留。只保留凭据的旧备份父目录和旧 Pi 父目录不代表旧日志仍在使用。生产进程始终保持原 PID 与启动时间；源码构建和数据清理不代表该进程已加载新版。

删除前绝对路径、用途、排除项、占用和哈希证据：C:/Users/Cx/AppData/Local/Temp/nailong-retirement-data-audit-20261017.json。删除后逐项目标及保留文件证据：C:/Users/Cx/AppData/Local/Temp/nailong-retirement-data-result-20261017.json。两份文件均不含私人对话、记忆正文或凭据。

## 完整删除清单

以下路径全部相对 D:/Code/nailong bot/data；凭据文件未包含在目标中。

- `checkpoints`
- `context-projections`
- `logs`
- `memory-initialization`
- `operations`
- `personal-history-backups`
- `personal-sessions`
- `tool-results`
- `embeddings.sqlite`
- `events.jsonl`
- `events.sqlite`
- `host-owner.sqlite`
- `memory.sqlite`
- `personal-history-migration.json`
- `personal-memory.sqlite`
- `personal.sqlite`
- `runtime-v2.sqlite`
- `runtime.sqlite`
- `pi-assistant-v1/owner.sqlite`
- `backups/runtime-handover-2026-10-05T09-38-55-420Z/backup-manifest.json`
- `backups/runtime-handover-2026-10-05T09-38-55-420Z/embeddings.sqlite`
- `backups/runtime-handover-2026-10-05T09-38-55-420Z/events.jsonl`
- `backups/runtime-handover-2026-10-05T09-38-55-420Z/events.sqlite`
- `backups/runtime-handover-2026-10-05T09-38-55-420Z/memory-initialization`
- `backups/runtime-handover-2026-10-05T09-38-55-420Z/memory.sqlite`
- `backups/runtime-handover-2026-10-05T09-38-55-420Z/migration-report.json`
- `backups/runtime-handover-2026-10-05T09-38-55-420Z/operations`
- `backups/runtime-handover-2026-10-05T09-38-55-420Z/runtime-v2.sqlite`
- `backups/runtime-handover-2026-10-05T09-38-55-420Z/runtime.sqlite`
- `backups/runtime-handover-2026-10-05T09-38-55-420Z/tool-results`
- `backups/runtime-handover-2026-10-05T09-44-40-095Z/backup-manifest.json`
- `backups/runtime-handover-2026-10-05T09-44-40-095Z/embeddings.sqlite`
- `backups/runtime-handover-2026-10-05T09-44-40-095Z/events.jsonl`
- `backups/runtime-handover-2026-10-05T09-44-40-095Z/events.sqlite`
- `backups/runtime-handover-2026-10-05T09-44-40-095Z/memory-initialization`
- `backups/runtime-handover-2026-10-05T09-44-40-095Z/memory.sqlite`
- `backups/runtime-handover-2026-10-05T09-44-40-095Z/migration-report.json`
- `backups/runtime-handover-2026-10-05T09-44-40-095Z/operations`
- `backups/runtime-handover-2026-10-05T09-44-40-095Z/runtime-v2.sqlite`
- `backups/runtime-handover-2026-10-05T09-44-40-095Z/runtime.sqlite`
- `backups/runtime-handover-2026-10-05T09-44-40-095Z/tool-results`
- `prototypes/pi-mono`

## 文档与评审

当前 README、操作说明、能力说明、CONTEXT 和 agent 指引描述现役职责。历史 ADR/研究/验收保留原结论，旧离线说明增加明确退役标注；涉及被删源码或退休符号的链接使用核对过的提交永久链接。

两轴评审结果随集成提交及 Issue 验证记录发布。未推送上游、未创建或合并 PR、未重启生产服务。
