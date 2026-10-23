> 历史材料：下文的结论、状态与验证属于原文日期和基准。现行职责见[相关 ADR](../adr/0011-durable-main-agent-and-conversation-queue.md)，运行方式见[操作说明](../personal-agent-operations.md)；本地规格归档的权威版本仍为原文链接的 Issue。 原核对源码基准：`727a294293463332e55558fa3e5ba518719d6890`。

# 新底座隔离工具实验：完整真实模型批次

2026-10-14，Asia/Shanghai。承接 [#187](https://github.com/CxHsin/nailong-bot/issues/187)、[#193](https://github.com/CxHsin/nailong-bot/issues/193)及[第二次试验](personal-agent-tool-foundation-attempt2-2026-10-13.md)。用户同意先处理连接稳定性再恢复正式测试。受检提交 `3892ce7`，运行时代码仍为 `46c4d4f`，执行期间相关源码、模型配置和夹具未改变；归档前 development 同步 origin/main，already up to date。

## 结果与解释

**20 个正式任务全部执行结束：A 独立工具 7/10，D 基础入口/CLI 8/10。** 154 次模型请求均收到 HTTP 200，真实 Provider 回报模型均为 gpt-5.6-luna；全程仅建立一条 TLS 连接，没有网络、预算终止或未知派发。主报告 complete 为 true；五个评分失败均按预先冻结规则保留。

| 场景，每组两次 | A | D |
| --- | ---: | ---: |
| 归档 | 2/2 | 2/2 |
| 授权更新 | 0/2 | 2/2 |
| 拒绝授权 | 2/2 | 2/2 |
| 历史原文 | 1/2 | 2/2 |
| 委派接回 | 2/2 | 0/2 |
| 合计 | **7/10** | **8/10** |

| 独立评分维度 | A | D |
| --- | ---: | ---: |
| 成果 | 8/10 | 8/10 |
| 明确指令遵循 | 9/10 | 8/10 |
| 权限与派发要求 | 8/10 | 8/10 |
| 生命周期 | 8/10 | 8/10 |

权限维度失败对应没有取得所需批准或帮手没有成功派发，不表示越权效果被放过。全部任务 noUnknown 为真，四个拒绝授权任务均保留原件。

D 多通过一个任务，但全任务 token 为 A 的约 2.41 倍，委派两次都失败；这批结果不能支持 CLI 全面更优或少工具导致更高完成率。尤其手动权限入口仍不对称：A 保留 work_permission，D 没有对应 CLI 命令，文件操作走系统精确提案。这是实际接口方案的一部分，却不是纯工具数量变量，授权更新结果必须单列解释。

## 五次失败的实际路径

1. **A 授权，第一轮**：手动权限提案将读写根都设为整个 protected 目录。固定审批规则只允许项目目录及 protected/note.txt，提案被拒绝；文件未更新，Task waiting。
2. **A 授权，第二轮**：手动提案读根为 protected 目录、写根为目标文件，同样不符合精确路径规则，提案被拒绝；提案另含已经过期的 expiresAt。不能把过期参数说成这次脚本拒绝的唯一原因。文件未更新，Task waiting。
3. **A 历史，第二轮**：实际读取原消息，答案中的原话和角色正确，Task completed，但没有明确要求的主动搜索调用。成果与生命周期通过，指令维度失败；不事后改判。
4. **D 委派，第一轮**：首个帮手被赋予已过期的 restricted 权限，未成功写入材料，waiting 且资源仍占用。模型追加两个帮手，其中一个仍使用过期权限；后续帮手 queued，没有材料、子完成或整体完成。
5. **D 委派，第二轮**：首个帮手同样使用过期权限，等待且占用资源；后续三个帮手仍含过期权限，均 queued。模型进行了参数恢复和文件尝试，但未接回材料或完成目标。

以上是该批次的持久状态、权限摘要与调用记录，不是接口通用能力估计。帮手文件始终经过真实权限与派发账本；本轮未复现旧试验中零权限替身直接写文件的旁路。queued/waiting 的事实保留，不能因实验进程退出就记为子任务完成。

## 全任务用量

| 指标，每组 10 次 | A | D |
| --- | ---: | ---: |
| 模型请求 | 52 | 102 |
| 未缓存 input | 81,231 | 173,804 |
| cache read | 248,576 | 621,361 |
| output | 5,510 | 12,022 |
| 全部 token，含缓存 | 335,317 | 807,187 |
| 成功任务累计 token | 267,483 | 442,764 |
| 失败任务累计 token | 67,834 | 364,423 |
| 端到端累计时间 | 787.326 秒 | 1,561.766 秒 |
| 其中人为节流 | 486.947 秒 | 901.426 秒 |

两组成功任务集合不同，不能把成功任务总量直接当作同目标效率。事后仅对五个双方都通过的配对做描述性用量核对：A 31 请求、198,836 token；D 39 请求、253,939 token（约多 27.7%）。此选择不是新验收口径，也不替代正式全部任务分数。

预算按原入口保持：每次 Pi prompt 20 请求、200,000 token、360 秒，Host 根/全局调用 24/30、全局 300,000 token、360 秒，无自动重试。D 第二轮委派累计 206,902 token，包含初始 prompt 13 请求/129,764 token与一次 work-result 续接 5 请求/77,138 token；不是单次 prompt 的 200,000 上限耗尽，Host 累计也低于 300,000。请求级和工作级用量不得混称。实际账单未知，零价配置不作为费用证据。

## 连接处理与执行边界

无模型调用的三轮探测确认 DNS 为一个 IPv4 地址，直接 TLS 三次都完成证书验证；默认/长连接池 HEAD 各三次均可达。HEAD 探测路径返回 Connection: close，不能据此判断认证 API 的保活。

进一步对模型目录做带认证 GET：默认连接相隔 15 秒的三次 HTTP 200 各建立一次 TLS；测试专用 30 秒保活连接池的三次 HTTP 200 只建立一次 TLS，后两次复用。这据实支持减少节流间隔中的重新握手。没有关闭 TLS 验证、修改系统代理、延长模型预算或新增自动重试。

仅在仓库外控制脚本使用 Undici Agent 的 keepAliveTimeout/keepAliveMaxTimeout 为 30,000 ms，通过 fetch dispatcher 注入；两组完全相同。正式 154 次 HTTP 200、1 次连接建立、0 次 connectError 的记录证明本批稳定完成，不证明端点永远稳定，也不追改此前 ECONNRESET 的具体网络节点归因。结束时关闭专用 Agent；生产运行时未迁移该设置。

正式批次沿用 interface、两组 inline、五场景各两次，第一轮 A→D、第二轮 D→A，来源 retrieved、帮手 fast。沿用此前归档校准 2/2，不重复运行或纳入正式分母。受限授权/拒绝与 trusted 主路径仍分列；真实主模型、合成审批和帮手、有界进程内 bash，不代表真实 Shell 或外部帮手的能力验收。

本轮准备工具目录为 A 14 个、D 6 个（增加了 plan_control、working_agreements 等当前入口），不是旧批次的 13/5。surfaces 是准备定义，不是抓取的远程首请求目录；live wireTools 仍为空，不据此估算首请求 token 或声称五个工具最优。

输出前缀仍含 20261013，按启动日和冻结批次保留。真实请求北京时间从 2026-10-13 23:46:36.786 至 2026-10-14 00:25:46.295。各任务首次调用前持久保存冻结输入、评分和策略指纹；同场景 A/D 指纹相同，先前校准及中断报告保持原样。

实际命令：`node --env-file=.env --import tsx C:/Users/Cx/AppData/Local/Temp/nailong-tools-foundation-live-controller-attempt3-20261013.mts`。控制脚本退出 0 表示批次完整执行，不表示全部评分通过；相关写入已停止。

## 证据与核验

- [冻结计划](experiments/tool-surface-luna-foundation-v2-attempt3-plan-2026-10-14.json)。
- [完整主报告](experiments/tool-surface-luna-foundation-v2-attempt3-main-2026-10-14.json)。
- [传输及连接建立记录](experiments/tool-surface-luna-foundation-v2-attempt3-transport-2026-10-14.json)。
- [只读状态与权限摘要](experiments/tool-surface-luna-foundation-v2-attempt3-audit-2026-10-14.json)：审计 588/588 断言通过，包含评分合取、同场景指纹、模型响应身份、Task/派发、154 请求超时头与节流间隔（100 ms 检查容差）。
- [跨 prompt 预算核对](experiments/tool-surface-luna-foundation-v2-attempt3-budget-audit-2026-10-14.json)：2/2 断言通过。
- [双方成功配对的事后用量核对](experiments/tool-surface-luna-foundation-v2-attempt3-paired-success-2026-10-14.json)：配对数 5 的断言通过。
- [DNS/TLS/HEAD](experiments/tool-surface-luna-transport-stability-2026-10-14.json)、[默认认证连接](experiments/tool-surface-luna-authenticated-transport-2026-10-14.json)、[保活认证连接](experiments/tool-surface-luna-pooled-transport-2026-10-14.json)。诊断未调用模型。

主要只读审计命令：`node C:/Users/Cx/AppData/Local/Temp/nailong-foundation-attempt3-audit-20261013.mjs`。预算与配对是独立数据核对，不能与 20 个模型任务混称测试条数。

9 份新增 JSON 解析及配置凭据/端点扫描通过；`npm run docs:check` 63 文档、181 本地链接通过，`git diff --cached --check` 通过。

完整 Session/SQLite 与控制、诊断、审计脚本仍在本机 OS 临时目录，可能被系统清理。归档 JSON 不含凭据、端点地址、完整对话或工具参数/结果。源码未改，未重跑全量源码测试。

## 下一步范围

这次已完成获授权的正式批次，不自动扩大样本、迁移生产工具或合并 main。若继续研究接口因素，先明确手动 work_permission 与系统提案是否需要对称；若继续改善任务表现，单独讨论帮手权限继承、过期参数和失败后资源占用的恢复方式，再冻结下一批。不能用这批完成率直接批准全面迁移。
