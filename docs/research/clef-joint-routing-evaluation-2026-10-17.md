> 历史材料：下文的结论、状态与验证属于原文日期和基准。现行职责见[相关 ADR](../adr/0013-contextual-input-routing.md)，运行方式见[操作说明](../personal-agent-operations.md)；本地规格归档的权威版本仍为原文链接的 Issue。

# Clef 完整动作路由的实现与真实 API 验收

历史记录：本次实现后来按用户要求退役，专用适配器、配置及验收脚本均已删除。以下描述保留当时的状态与证据；[原适配器](https://github.com/CxHsin/nailong-bot/blob/d090d92979a7fbe471ca2c074de5d48291c787f2/src/assistant/intent-clef.ts)、[原脚本](https://github.com/CxHsin/nailong-bot/blob/d090d92979a7fbe471ca2c074de5d48291c787f2/scripts/acceptance/clef-routing-live.ts)。当前入口见[操作说明](../personal-agent-operations.md)。

2026-10-17，任务 [#220](https://github.com/CxHsin/nailong-bot/issues/220)，关联规格 [#215](https://github.com/CxHsin/nailong-bot/issues/215)。基准为 development 的 `a235df2` 加本次改动。此前的[双问题实验](clef-live-evaluation-2026-10-17.md)保留为历史证据。

## 结论

完整动作单选已接入现有分类入口，但本轮真实结果不足以支持替换现有分类器。Clef 原 16 例最终路由符合预期 15 例，新增 12 例符合预期 9 例；Flash 分别为 12/16 和 7/12。Clef 仍把“为什么季度收入图表还没有完成？”判为补充，Flash 还出现错误目标和复合消息漏判。不能将可解析、目标身份存在或本地测试通过等同于语义正确。

此轮只运行合成输入的真实 Cloudflare API，调用的就是运行时适配器；没有启动 Telegram、主 Bot 或 herdr，没有执行这些补充或取消，没有新增 herdr workspace。`.env` 中现有分类器选择未被本次实现改动，不由本记录推导上线状态。

## 复盘结论：让路由适应正常聊天表达

2026-10-18，用户要求保存此前讨论中的以下判断，作为后续复盘依据：

> 至少在这次任务里，确实如此。用户说的“先别停”“为什么还没完成”“刚才那份改一下”都是正常聊天表达，Bot 应该适应这些说法。
>
> 这类决策模型更适合类别稳定、上下文关系简单、候选差异明确的场景。你的路由还要理解回复、指代、否定、多个要求，以及工作状态，实际上已经接近一次小型阅读理解。输出只有几个选项，理解难度依然很高。
>
> 如果必须先用大模型把原话整理成标准表达，再让它分类，就会抵消一部分速度和成本优势。因此，这个 Bot 我更倾向用理解能力足够的通用小模型直接判断上下文，把 Clef 留作实验对照，避免让用户迁就分类器的表达限制。

这段话记录当时针对本 Bot 的工程判断，不是对所有决策模型、中文能力或成本优势的普遍证明。“把 Clef 留作实验对照”是当时建议；用户后来已要求删除专用程序，当前只保留历史实验和证据，不恢复入口。

后续排查确认上下文组装和提示也影响结果：助手单独历史曾被丢弃，回复关系与视觉条件的说明不够明确，修复记录见[三类上下文评测](routing-three-context-evaluation-2026-10-17.md)。复盘时应先核对实际输入和提示，再区分模型判断问题；模糊表达应澄清，不要求猜中目标。通用小模型同样须通过真实路由验收，不能仅凭本段选型倾向视作可靠。

## 实现和边界

- 在 `createIntentClassifier` 内增加可选 Clef 适配器，保留通用模型别名、默认未配置行为及主 Bot 模型目录。配置见[操作说明](../personal-agent-operations.md)。
- 一个 choice 同时绑定动作和真实工作身份。候选包括独立请求、不确定、复合输入，以及每项工作的补充/取消；不再分别询问 kind 和 target 后拼装。
- 候选描述直接携带 `verifiedReplyTarget`，数据来自既有真实回复关联。明确指定其他对象可以覆盖回复；不在程序中盲目强制回复对象。
- 复用输入预算、候选完整性、目标和执行前状态校验。省略候选标记不完整，不能因仅剩一项就自动取消。
- 选择不确定时生成澄清动作；选择复合时完整原文交现有主 Bot。模型漏判复合时，单选协议本身无法保证不产生错误控制输出，本轮 Flash 已出现此类失败。
- 可选置信门槛仅将低分结果转为澄清，默认不设门槛。分数未经校准；Flash 的错误复合取消置信度为 0.6166，不能据本轮样本假定 0.5 能过滤全部错误。
- 无工具、非流式、单次调用、不重试，默认超时 8 秒；迟到结果丢弃。快照保留决定及概率，不包含凭据。

## 样本与评分

原 16 例从历史 `cases.json` 原样复制，仅增加 cohort 标签。新增 12 例在第一次调用前冻结，覆盖明确他指覆盖回复、多目标回复、否定中断、单目标指代、中文省略、不同目标复合、取消后新建、状态提问、引用指令、完整名称及未知目标。两种模型使用同一组 28 例，样本 SHA256：

`b95acc289b828291a2fffce8780100991408cddeeb11eb4236a49ad2d347deca`

`clef-routing-live.ts` 记录三层结果：语义动作种类、目标定位、最终路由。语义层不把“不确定”直接算作理解错误，也不算正确识别了取消；目标层区分正确目标、正确歧义、未消歧和错误目标。最终路由按冻结的期望严格计分：额外澄清、误判复合以及安全兜底不自动算通过。鉴权、网络和协议错误单独记录，不算模型拒答或中文语义失败。

| 模型 | 原 16 例最终路由 | 新增 12 例最终路由 | 错误补充/取消输出（未执行） | API/协议错误 |
| --- | --- | --- | --- | --- |
| Clef Flash | 12/16 | 7/12 | 7 | 0 |
| Clef | 15/16 | 9/12 | 1 | 0 |

| 模型 | 语义种类正确 | 语义未决 | 语义种类错误 |
| --- | --- | --- | --- |
| Clef Flash | 22 | 1 | 5 |
| Clef | 19 | 6 | 3 |

语义种类正确仍可能选错工作；Clef 更多选择未决，因此不能只比较“种类正确”数量排列中文理解能力。本轮同时改变了输出契约、候选描述、提示和评分表达，不能把与旧实验的差异单独归因于其中一项，也不能据 28 个合成样本推导总体准确率或训练语种弱点。

Clef 的四项未通过分别是：同主题报告有真实回复仍澄清；“停止图表，报表继续”误判复合；“图表先别停，把背景改白”误判复合；状态提问误判补充。前三项保留原文而未暴露控制，第四项输出错误补充。Flash 的不完整候选取消被现有 `incomplete_target` 校验挡住，仍不算分类正确。

## 延迟和原始证据

| 模型 | P50 | P95 | 已查询 |
| --- | --- | --- | --- |
| Clef Flash | 849 ms | 1425 ms | 28/28 |
| Clef | 918 ms | 2039 ms | 28/28 |

每例仅请求一次，单批顺序调用，不作为性能排名。两个进程都因存在语义/路由失败而退出 1；不是脚本崩溃。全部有效批次返回 HTTP 200，并通过适配器响应校验。

本机临时证据（未入库）：

- `C:/Users/Cx/AppData/Local/Temp/nailong-clef-routing-joint-flash-20261017-r3/`
- `C:/Users/Cx/AppData/Local/Temp/nailong-clef-routing-joint-clef-20261017-r3/`

各目录包含查询前冻结的 `cases.json`、逐项 `results.json` 和 `summary.json`；逐项保存实际请求状态/候选、原始 answers、usage、HTTP 状态、ray、生产适配器快照和最终结果，不保存请求头、密钥或账户 URL。复现：

```powershell
node --env-file=.env --import tsx scripts/acceptance/clef-routing-live.ts <新的仓库外目录> clef-flash
node --env-file=.env --import tsx scripts/acceptance/clef-routing-live.ts <另一个新的仓库外目录> clef
```

脚本拒绝覆盖已有目录；401/403 提前终止，报告已查询与未测数量。

之前两个批次分别位于 `nailong-clef-routing-joint-flash-20261017/` 和同名 `-r2/`，存在鉴权或网络失败，不能用于语义评分。初次将账户级 Token 在 `/user/tokens/verify` 的拒绝当作 Token 无效，结论不准确；正确的账户验证接口返回 active。后续 Token 详情接口明确返回 403/9109（来源地址不允许），用户调整 IP 筛选后，上述 r3 批次实际成功。账户 Token 的验证接口与[兼容矩阵](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)不同于用户 Token；[Run API](https://developers.cloudflare.com/api/resources/ai/methods/run/)列出 Workers AI Read 或 Write 至少一项，不要求为了本实验扩大到所有权限。

## 本地验证

- `node --import tsx --test --test-concurrency=4 test/*.test.ts`：200/200 通过，其中新增 Clef 7 项，日志在本机临时目录 `nailong-clef-routing-tests-20261017.log`。
- 新测试覆盖完整动作/真实回复描述/明确他指、歧义/复合/可选门槛、未知选择及无效分数、候选预算与选项限制、超时迟到、启动配置，以及真实 Assistant Service 队列到同一主模型的完整原文兜底。受控响应只证明适配器和路由行为，不证明真实模型语义。
- `npm run typecheck`、`npm run build` 通过。
- 验收脚本独立严格 TypeScript 检查通过（acceptance 目录不在主 tsconfig 中）。
- `npm run docs:check`：91 篇跟踪文档、331 个本地链接通过；`git diff --cached --check` 通过。

保留适配器供继续比较和受控试用，当前结果不关闭 #220 的真实可靠性缺口，不自动更换运行中的分类器，也不据此引入关键词拆句、强制回复、训练或多级模型体系。
