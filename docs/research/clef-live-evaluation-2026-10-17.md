# Clef 中文上下文决策 API 实测

2026-10-17（北京时间），使用用户已填入本地 `.env` 的 Cloudflare Account ID 和 Workers AI API token 进行真实 HTTP 调用。只发送合成场景；没有启动 Telegram、helper 或新 workspace，没有切换生产分类器，也没有将密钥保存到结果或提交中。

## 结论与范围

凭据可用。Clef Flash 和 Clef 各完成 16 个相同场景，均 HTTP 200，无格式错误、网络错误或 8 秒超时。按预先固定的“动作类别与目标同时匹配”标准，两者均为 **11/16**。这是一次小样本接口探索，不是生产准确率或稳定延迟保证。

| 模型 | 严格匹配 | P50 | P95 / 最大 | 计费输入 tokens |
| --- | --- | --- | --- | --- |
| `clef-flash` | 11/16 | 869ms | 3653ms | 12,004 |
| `clef` | 11/16 | 531ms | 1240ms | 12,004 |

每个模型每个场景只调用一次，串行执行，无自动重试。P95 使用 nearest-rank；16 次样本中 P95 正好等于最大值。P50 使用同一算法。两轮在不同时间执行，连接复用、排队与网络状态未控制，因此不能凭本轮说 Clef 普遍更快。正式用例前另有一次 180 input tokens 的 Flash 连通调用，耗时 4218ms，未纳入表中。

按[官方等价单价](https://developers.cloudflare.com/workers-ai/platform/pricing/)估算，两轮输入合计约 $0.00334（含连通调用），输出免费。此为 token 单价估算，不是账户实际账单；免费配额与最终结算由 Cloudflare 账户决定。

## 固定场景与原始判定

每场景输入包括当前用户文字、实际候选任务、近期对话、已认证回复目标和候选是否完整。向模型并行问两个封闭问题：动作类别、候选目标。两模型使用同一规则、同一预期；没有看到第一轮结果后改写提示词或筛选用例。

`none` 表示新请求不改变已有工作；`ambiguous` 表示无法确定已有目标。`compound` 仅表示识别出多个动作，不证明可以生成有序动作及对应原文片段。

| 场景 | 预期：动作/目标 | Flash 实际 | Clef 实际 |
| --- | --- | --- | --- |
| 独立新请求 | request/none | request/none ✓ | request/none ✓ |
| 已有工作时的新请求 | request/none | request/none ✓ | request/none ✓ |
| 明确补充 | supplement/report | supplement/report ✓ | supplement/report ✓ |
| 近期指代 | supplement/report | supplement/report ✓ | supplement/report ✓ |
| 跨无关消息补充 | supplement/report | supplement/report ✓ | supplement/report ✓ |
| 明确取消 | cancel/report | cancel/report ✓ | cancel/report ✓ |
| 多目标歧义 | clarify/ambiguous | cancel/report × | cancel/ambiguous × |
| 真实回复身份优先 | supplement/report | supplement/none × | supplement/report ✓ |
| 同主题的新工作 | request/none | request/none ✓ | request/none ✓ |
| 否定取消并补充 | supplement/report | supplement/report ✓ | supplement/report ✓ |
| 复合动作识别 | compound/chart | compound/chart ✓ | compound/chart ✓ |
| 不完整候选不能按唯一性取消 | clarify/ambiguous | cancel/report × | cancel/ambiguous × |
| 有回复身份的不完整候选 | cancel/report | cancel/report ✓ | cancel/ambiguous × |
| 上下文中嵌入的取消指令 | request/none | request/none ✓ | request/none ✓ |
| 两份同主题报告需要澄清 | clarify/ambiguous | supplement/ambiguous × | supplement/report × |
| 同主题报告由回复消歧 | supplement/annual | supplement/ambiguous × | supplement/ambiguous × |

Flash 对“那个先别做了”在多目标及不完整候选两种情况下均选了具体 `report`，目标置信度分别为 0.3523、0.4774；并非高置信度取消，但若调用方直接执行最高概率选项就会误取消。Clef 在对应两条返回 `ambiguous`，程序可据此澄清；其动作仍是 cancel，因此按此次严格双字段标准计失败。这类组合不是单纯 JSON 格式失败，而是需要明确的业务映射。

两个问题独立回答，因而可能出现 `supplement/none` 或 `cancel/ambiguous`。当前实验没有调阈值或增加后处理来美化通过率。一次小样本也不能证明一个固定阈值能区分全部正确与错误案例。

## 对接入的含义

API 适合提供类别、候选目标及不确定性信号；目前证据不足以直接替换 [生产分类器](../../src/assistant/intent.ts)。真实回复身份应显式参与目标解析，歧义和不完整候选需要程序约束，不能仅依赖概率最高的选项。

当前分类器还要求一条输入内多个动作的先后顺序和精确原文片段。本实验没有测试这部分，没有执行实际取消或投递，也没有验证端到端 Bot 路由；既有验证与降级职责见 [ADR-0013](../adr/0013-contextual-input-routing.md)。后续接入需覆盖这些合同后再用真实链路验收。

## 复跑与证据

[脚本](../../scripts/acceptance/clef-live.ts)从环境读取凭据，单次请求上限 8 秒。会发送真实 API 请求；任何场景不匹配时最终以退出码 1 报告，仍保存全部场景结果。

```powershell
node --env-file=.env --import tsx scripts/acceptance/clef-live.ts C:/Users/Cx/AppData/Local/Temp/nailong-clef-eval-20261017/flash clef-flash
node --env-file=.env --import tsx scripts/acceptance/clef-live.ts C:/Users/Cx/AppData/Local/Temp/nailong-clef-eval-20261017/clef clef
```

每个输出目录的 `cases.json` 保存调用前冻结的输入及预期，`results.json` 保存每次合成输入、完整答案概率、耗时、usage 和 Cloudflare ray，`summary.json` 保存汇总。不保存 Account ID、token 或 Authorization 标头。开始时间分别为北京时间 00:27:35、00:28:21；原件位于上面的仓库外临时目录。

脚本通过显式 TypeScript 严格检查；文档通过仓库本地链接检查。测试仅验证外部 API 候选，没有修改生产配置。
