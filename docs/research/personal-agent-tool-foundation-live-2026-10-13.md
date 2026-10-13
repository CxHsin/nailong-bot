# 新底座工具接口隔离测试：校准中断

2026-10-13，Asia/Shanghai。承接 [#187](https://github.com/CxHsin/nailong-bot/issues/187) 的真实模型实验与 [#193](https://github.com/CxHsin/nailong-bot/issues/193) 的底座校准。受检源码为 `46c4d4fe8ee494ddbbfaa79da04fb3bb3fa27d38`，启动前 development 同步 origin/main，结果 already up to date。

## 结果

归档校准的 A 组在第二次模型请求出现 `Request timed out.`，控制脚本按用户确认的停止条件暂停。D 组未开始，20 个正式任务未开始；没有自动重试。本次不能比较接口优劣，也不计入完成率分母。

第一条模型响应在北京时间 22:59:04.052 正常结束于 `toolUse`，调用 `read` 并成功读取合成 `project/source.txt`。第二条响应在 22:59:19.766 结束于 `error`，错误为 `Request timed out.`，没有工具调用或已记录用量。Task 最终为 waiting，revision 0；原始 source.txt 保留，尚未进行归档。

记录了 2 次请求，input 5,423、output 144、cache read/write 均为 0，共 5,567 token；校准任务耗时 25,714 ms。错误不是配置的 20 请求、200,000 token 或 360 秒整轮上限耗尽。现有错误记录没有 HTTP 状态码、请求 ID 或底层 cause，无法确定超时发生在客户端、网络、中转端点还是上游。未复现该超时，未修改运行时代码。

报告 `complete: false`，`checks` 为空：执行在评分前抛错，预初始化为 false 的 `scores`/`passed` 不是已计算的模型失败成绩。费用仍未知；端点零价及错误响应零用量不代表实际零收费。

## 已确认方案与执行方式

- 单因素 interface：A 独立工具与 D 基础入口/CLI，两组 inline 指导；两组共用当前状态、工作目录、权限审批、执行与完成语义。
- 模型沿用 `gpt-5.6-luna`，从现有 `gpt` 配置读取凭据，仅测试进程覆盖模型名与原生工具能力标记，不修改 `.env`。
- 归档场景 A/D 各一次作为独立校准；链路正常后执行 organize、approval、denial、memory、delegation，每组各两次；第二轮反转组序。主批次默认 memory 来源 retrieved、帮手 fast。
- HTTP/预算错误、底座异常或越权效果出现时暂停；普通模型选择、恢复与结算失败作为四维评分结果继续记录。
- 复用[校准实验入口](../../scripts/experiments/tool-surface/README.md)的冻结与评分、Pi/Host 预算，每次请求跨任务至少间隔 15 秒，不自动重试。
- 原入口不会逐任务遇基础设施错误暂停，因此用仓库外临时控制脚本直接调用同一 `runExperiment`，首次请求前保存冻结报告，任务结束后只读核对 Session 与 SQLite 再决定是否继续。未改变接口或评分实现。
- 真实主模型，合成审批与帮手，有界进程内 bash；不作为系统 Shell、真实帮手或生产部署验收。

本次没有形成新的领域术语或难以逆转的架构决策，沿用 CONTEXT.md 与 ADR-0009；不增加 ADR。

## 证据与验证

- [冻结计划](experiments/tool-surface-luna-foundation-v2-plan-2026-10-13.json)。
- [未完成校准报告](experiments/tool-surface-luna-foundation-v2-calibration-2026-10-13.json)：包含首次调用前的输入、材料、评分、策略指纹与实际执行记录。
- [只读字段审计](experiments/tool-surface-luna-foundation-v2-audit-2026-10-13.json)：模型停止原因、时间、已完成工具、Task 终态、原件与评分状态。
- 实际运行：`node --env-file=.env --import tsx C:/Users/Cx/AppData/Local/Temp/nailong-tools-foundation-live-controller-20261013.mts`。控制脚本退出 1，原因是检测到 assistant-error/harness-error 后主动停止。
- 实际只读核验：`node C:/Users/Cx/AppData/Local/Temp/nailong-foundation-live-audit-20261013.mjs`，10/10 数据断言通过，核对不完整批次、单个任务、两次请求、超时错误、两条模型响应、停止原因、waiting、原件保留与评分未计算。
- 3 份归档 JSON 解析、配置凭据/端点扫描与中断批次断言通过；`npm run docs:check` 通过（61 文档、161 本地链接），`git diff --cached --check` 通过。本次仅归档文档与证据，没有重新运行源码全量测试。

Session/SQLite 与控制、审计脚本位于本机 OS 临时目录，可能被系统清理；仓库归档 JSON 不含凭据、端点 URL、完整模型对话或工具参数/结果。临时 root 见校准报告。本次停止后所有实验写入已结束。

## 下一步

继续真实请求前，先明确是否排查并修复此次超时，或在不改变配置的条件下开启新的校准批次。新尝试单独冻结并保存，原中断记录保持不变；两组尚无可比较分数。
