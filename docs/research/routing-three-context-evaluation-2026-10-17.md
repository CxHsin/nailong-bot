> 历史材料：下文的结论、状态与验证属于原文日期和基准。现行职责见[相关 ADR](../adr/0013-contextual-input-routing.md)，运行方式见[操作说明](../personal-agent-operations.md)；本地规格归档的权威版本仍为原文链接的 Issue。

# 路由三类上下文修复与同组重测

2026-10-17（北京时间），任务 [#223](https://github.com/CxHsin/nailong-bot/issues/223)，Part of [#215](https://github.com/CxHsin/nailong-bot/issues/215)，承接 [#222](https://github.com/CxHsin/nailong-bot/issues/222)。用户明确每次用户输入触发判断，每次提供当前消息及 Telegram 回复、近期交流、当前/排队/helper 工作身份与目标状态。受检基准为 `ba555b0` 加本次修改。

## 入口及材料

应用原有入口在每条普通用户输入持久接收后触发路由，不等待主 Bot 的长轮次；同会话按输入顺序处理，重复来源身份复用原记录，确定命令走命令入口。没有新增路由服务、消息合批等待或 workspace。

本次补齐 Telegram `reply_to_message` 的原文/caption、角色及图片标记，沿通道、持久 QueueInput 到实际分类请求。`current` 同时保留用户当前原文、图片标记、回复消息 ID/原输入 ID；`replyTargets` 继续由原输入/真实发送回执关联工作，未知回复不猜造目标。不下载被回复的图片，不将其正文当作当前用户命令。

`recent` 保留完整可见用户轮次及已确认助手文字，修复没有前置用户消息时助手文字被丢弃的问题。预算先保留当前及回复信息、工作身份和最多 512 字的目标摘要，再由近到远加入完整交流；遇到一轮放不下就停止，不跳过它回填更旧对话。与之前摘要放在近期对话之后的顺序相比，这次优先保证工作列表可理解；默认 8192 输入预算、6 轮、1024 输出、8 秒期限不变。当前消息或回复材料本身超预算时完整降级，不截掉文字后执行控制。

`works` 沿用实际当前执行、队列和已关联 helper 的工作及真实状态。helper 缺少历史目标关联时继续标记候选不完整，不发明可控制的身份。reset、遗忘与跨会话过滤保持原路径，不把全部历史/工具轨迹注入分类器。

提示改为中文明确解释三类字段、真实回复关联、资料与当前授权的区别，以及补充、新请求、取消、澄清的含义。省略句需要结合三类材料理解；needs_visual 仅用于当前确有图片且文字上下文仍不足时。Cloudflare JSON Schema、模型专用思考控制、一次无工具判断、原文跨度/目标/完整性及执行前状态校验保留。

## 更正前轮证据边界

[最初 Cloudflare 基准](cloudflare-general-routing-evaluation-2026-10-17.md)及[调用修复批次](cloudflare-routing-controls-evaluation-2026-10-17.md)中的第 8、14 例，只含助手消息的 recent 被旧组装器变成空数组。因此前轮第 14 例并没有测试到实际发送历史嵌入指令的边界；前轮成绩保留，但不能将所有失败归因于模型能力。

本轮逐项核对两模型的持久快照，28 例的全部工作摘要和源 recent 都保留，第 8、14 例助手文字实际进入有 HTTP 响应的请求正文。冻结数据本身没有 Telegram 回复消息正文/消息 ID，只有 replyTargets；本轮仍原样使用，新增通道字段由 Telegram HTTP 集成测试验证，没有向冻结样本补充暗示答案的材料。

## 同组真实 API 结果

样本、评分、脚本不变，每模型顺序 28 条、每条一次无重试。SHA256：

`b95acc289b828291a2fffce8780100991408cddeeb11eb4236a49ad2d347deca`

| 模型 | 调用修复后基准 | 本轮原 16 例 | 本轮新增 12 例 | 本轮总计 | 错误控制 | 超时 |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen3-30B-A3B | 11/28 | 12/16 | 7/12 | 19/28 | 4 | 0 |
| GLM-4.7-Flash | 16/28 | 8/16 | 8/12 | 16/28 | 4 | 2 |

| 模型 | P50 / P95 | 协议处理统计 |
| --- | --- | --- |
| Qwen | 1265 / 1867 ms | 25 accepted、1 incomplete_target、1 undecidable、1 invalid_result |
| GLM | 1957 / 8010 ms | 25 accepted、1 incomplete_target、2 timeout |

两模型本轮均无 needs_visual 误判。Qwen 第 8 例回复报表修改、第 16 例回复消歧通过；GLM 第 8 例通过、第 16 例仍判断为新请求。Qwen 28 次 HTTP 200；GLM 26 次 HTTP 200、2 次超时无响应证据。单批比较同时包含上下文、提示语言和解释、预算顺序变更，不能独立量化哪一项贡献了提升，也不能据此推导总体准确率。

模型目标判断仍有阻断问题：Qwen 在多个合理目标、回复关联多个目标、未知视频任务上猜选 report，还在两份同主题报表中直接修改一份；GLM 同样在歧义/未知对象上误选，并把明确另建报表并入旧任务、把“报表继续”输出为补充。错误控制按冻结脚本定义计数，包含多余控制，不只统计选错 ID。第 14 例现在实际收到不可信历史，Qwen 返回未决、GLM 多余澄清，两者都没有取消，但也没有正确识别独立天气问题，因此仍记失败。Qwen 第 17 例重复使用同一原文跨度，被完整拒绝；两模型第 12 例均被 incomplete_target 保护挡住，但没有正确澄清，也仍记失败。

**三类上下文接入已经修复；这批模型仍不足以自动控制任务。** 本轮没有切换运行中的 Bot、真实发送 Telegram 或执行样本控制动作，没有恢复 Clef、启动 herdr 或创建 workspace。

## 验证与证据

新增 2 个分类器回归测试，覆盖助手单独历史、混合交流、回复字段实际出站、回复材料超预算完整降级、工作摘要优先及近期连续后缀。去掉历史修复或工作摘要预算顺序，会使对应测试失败。

加强 Telegram 集成测试，实际由 grammY update 经持久应用到 HTTP 分类请求核对用户/助手回复身份和正文、图片 caption/标记、未知回复、来源去重；加强 helper 集成测试，在主 Bot 工具保持忙碌时核对当前/排队/helper 身份目标状态与用户/Bot 近期交流同时存在。reset 和遗忘过滤继续由原集成回归验证。

本机批次证据：

- `C:/Users/Cx/AppData/Local/Temp/nailong-cf-qwen-routing-three-context-20261017/`
- `C:/Users/Cx/AppData/Local/Temp/nailong-cf-glm-routing-three-context-20261017/`

每目录含原样 cases.json、逐项请求/响应/快照、results.json、summary.json；不保存密钥、请求头或账户 URL。两脚本均因样本失败退出 1，没有补跑或改记成功。全仓检查日志：`C:/Users/Cx/AppData/Local/Temp/nailong-routing-three-context-tests-20261017.log`。

- 全仓 `node --import tsx --test --test-concurrency=4 test/*.test.ts`：198/198 通过。
- `npm run typecheck`、`npm run build`、验收脚本独立严格 TypeScript 检查通过。
- `npm run docs:check`：94 篇跟踪文档、345 个本地链接通过；暂存差异空白检查通过。
