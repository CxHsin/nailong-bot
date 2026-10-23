> 历史材料：下文的结论、状态与验证属于原文日期和基准。现行职责见[相关 ADR](../adr/0011-durable-main-agent-and-conversation-queue.md)，运行方式见[操作说明](../personal-agent-operations.md)；本地规格归档的权威版本仍为原文链接的 Issue。 原核对源码基准：`727a294293463332e55558fa3e5ba518719d6890`。

# 新底座隔离实验：校准通过，正式批次连接中断

2026-10-13，Asia/Shanghai。用户在[首轮超时排查](personal-agent-tool-foundation-live-2026-10-13.md)后要求继续，承接 [#187](https://github.com/CxHsin/nailong-bot/issues/187)、[#193](https://github.com/CxHsin/nailong-bot/issues/193)。受检源码为 `2f53189`，运行时代码仍为 `46c4d4f`；实验结束后、归档前 development 同步 origin/main，already up to date。

## 结果

**归档配对校准 2/2 通过；正式批次首个 A 任务在第六次请求发生 TLS 建立前连接重置，按约定暂停。** 未自动重试，正式批次其余 19 个任务未启动。没有完成的正式 A/D 配对，不能计算正式完成率或比较接口优劣。

校准两组都完成文件归档和成果核验，Host Task 为 completed，成果、指令、权限、生命周期四维均通过。输入与策略指纹相同，真实 Provider 回报的模型均为 `gpt-5.6-luna`。

| 校准组 | 请求 | 全部已记录 token（含缓存） | 端到端时间 | 其中节流 |
| --- | ---: | ---: | ---: | ---: |
| A 独立工具 | 10 | 63,343 | 156.560 秒 | 48.953 秒 |
| D 基础入口/CLI | 14 | 86,882 | 210.751 秒 | 80.931 秒 |

校准只有一个场景、每组一次，结果单列，不加入正式批次。D 有可恢复的工具错误但最终四维通过；CLI 外层与内部动作的 trace 不能相加当独立失败次数。现有样本不支持通用完成率或性能判断。

## 正式任务的失败边界

正式 A 组归档前五次请求均收到 HTTP 200；第六次请求北京时间 23:23:49.814 开始，3,007 ms 后 fetch 抛出 TypeError，底层 cause code 为 **ECONNRESET**。持久模型错误为：

> Client network socket disconnected before secure TLS connection was established

本次确定是在获得 HTTP 响应前、TLS 尚未建立时连接断开。没有失败 HTTP 状态，也无法仅靠这个错误确定哪个网络节点重置连接；不能归因模型行为、权限或接口选择。配置的请求超时为 360 秒，远未达到上限。本次错误类型与首轮泛化超时不同，不追改首轮原因。

中断前实际创建 archive、移动 source.txt、写 result.txt 并读回归档原文。审计确认原文为 synthetic-source，结果文件说明归档位置，三项变更都有 succeeded 派发记录；Task 仍 waiting，整体未完成。`checks` 为空，说明评分前执行失败，预初始化 false 不视作模型失败成绩。

正式中断任务记录 6 次请求，input 8,393、output 369、cache read 20,480，共 29,242 token；耗时 81.807 秒，节流 26.794 秒。加校准共 30 次请求、179,467 已记录 token；失败请求未返回用量，实际费用未知。

## 执行与冻结

沿用已确认的 interface 单因素、两组 inline 指导、相同底座与预算、gpt-5.6-luna、五场景两重复、第二轮反转顺序；校准单列。来源 retrieved，帮手 fast。本轮未改变提示、工具、评分、模型配置文件或运行时代码。

在仓库外控制脚本的 fetch 边界补充逐请求元数据：阶段、场景、组、序号、开始时间、请求超时头、HTTP 状态、耗时、错误类型与 cause code。不记录凭据、端点、请求正文或响应正文；SDK 丢失 cause 前先保存。本轮不改变请求重试或网络代理策略。

独立输出前缀 `nailong-tools-luna-foundation-v2-attempt2-20261013`，保留首轮报告。每个任务首次模型请求前保存输入、材料、四维评分、策略与 SHA-256。校准 complete 为 true，正式报告 complete 为 false；所有请求开始间隔核验为至少 15 秒（检查容差 100 ms）。本轮 30 个请求的超时头均为 360 秒。

实际命令：`node --env-file=.env --import tsx C:/Users/Cx/AppData/Local/Temp/nailong-tools-foundation-live-controller-attempt2-20261013.mts`。控制脚本发现错误后退出 1，相关实验写入已结束，未派发后续任务。

## 证据与核验

- [冻结计划](experiments/tool-surface-luna-foundation-v2-attempt2-plan-2026-10-13.json)。
- [完整校准报告](experiments/tool-surface-luna-foundation-v2-attempt2-calibration-2026-10-13.json)。
- [未完成正式报告](experiments/tool-surface-luna-foundation-v2-attempt2-main-2026-10-13.json)。
- [逐请求传输元数据](experiments/tool-surface-luna-foundation-v2-attempt2-transport-2026-10-13.json)。
- [只读状态与文件审计](experiments/tool-surface-luna-foundation-v2-attempt2-audit-2026-10-13.json)。

实际审计命令：`node C:/Users/Cx/AppData/Local/Temp/nailong-foundation-attempt2-audit-20261013.mjs`。89/89 断言通过：批次完整性、同组输入/策略一致、模型请求数、29 个 HTTP 200/1 个连接错误、请求超时头与节流间隔、实际文件、派发记录、Task 终态和评分状态。这里是数据核验断言，不是 89 个模型任务。

5 份新增 JSON 解析与配置凭据/端点扫描通过；`npm run docs:check` 62 文档、170 本地链接通过，`git diff --cached --check` 通过。

完整 Session/SQLite 与控制、审计脚本留在本机 OS 临时目录，可能被系统清理。仓库归档字段可复核本次结论；无 API Key、端点 URL、完整对话或工具参数/结果。未修改源码，不重跑源码全量测试。

下一步先处理端点连接稳定性，再开启独立的新正式批次；已有校准与中断记录保持原样，不能把已产出材料的中断任务改判为成功。

后续用户同意处理并恢复测试：[完整新批次](personal-agent-tool-foundation-complete-2026-10-14.md)在测试进程使用相同的保活连接池，20 任务执行结束，A 7/10、D 8/10；本次中断结果仍保留。
