# Cloudflare 分类调用修复与同组重测

后续核对发现本轮样本 8、14 的助手单独历史被组装器丢弃。此文保留当时实际成绩；不能把第 14 例算作已经验证了嵌入指令隔离。修正三类上下文后的独立重测见[后续记录](routing-three-context-evaluation-2026-10-17.md)，不把前轮全部失败归因于模型能力。

2026-10-17（北京时间）。任务 [#222](https://github.com/CxHsin/nailong-bot/issues/222)，Part of [#215](https://github.com/CxHsin/nailong-bot/issues/215)，承接 [#221](https://github.com/CxHsin/nailong-bot/issues/221)。受检代码为 `development` 的 `defc776` 加本次调用修复；[旧评测](cloudflare-general-routing-evaluation-2026-10-17.md)保留修复前结果。

## 修复内容与接口探测

原提示把 kind、target、candidates 放在同一个通用动作示例中。现改为各动作明确的字段形状，并要求复合输入返回全部有序动作。官方 Cloudflare OpenAI 兼容端点的 Qwen3-30B-A3B 和 GLM-4.7-Flash 分类请求增加 `response_format.type=json_schema`，Schema 用 `anyOf` 分别限制 request、supplement/cancel、clarify，禁止额外字段。Schema 和思考控制提示计入原输入预算。其他端点和模型不附加 Cloudflare 专用参数。

GLM 使用 `chat_template_kwargs.enable_thinking=false`。Qwen 使用快照之后的 `/no_think` 软开关，不发送硬开关，也不发送 `reasoning_effort`。本次极小合成探测中：

| 调用 | HTTP | 正文结果 | reasoning |
| --- | --- | --- | --- |
| Qwen：Schema + enable_thinking=false + /no_think | 200 | content=null | 整个 JSON 答案被放入 reasoning |
| Qwen：Schema + 默认模板 + /no_think | 200 | 正常 JSON | 仅空白 |
| Qwen：无 Schema + enable_thinking=false + /no_think | 200 | content=null | 整个 JSON 答案被放入 reasoning |
| Qwen：json_object + 默认模板 + /no_think | 200 | 正常 JSON | 仅空白 |
| GLM：Schema + enable_thinking=false | 200 | 正常 JSON | null |

这是本次 Cloudflare 接口观察，不把 Qwen 硬开关的返回直接解释成模型推理内容。分类器始终只读取 content，不从 reasoning 中恢复控制动作。Qwen 官方说明软开关会保留空的 think 标签块，硬开关则完全省略该标签；这一差异与本次 Cloudflare 正文解析行为吻合，未声称已定位其服务器实现。

参考：[Cloudflare OpenAI 兼容入口](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)、[JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)、[Qwen 输入 Schema](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/sync-input.json)、[GLM 输入 Schema](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/sync-input.json)、[Qwen 官方软/硬开关说明](https://huggingface.co/Qwen/Qwen3-30B-A3B#advanced-usage-switching-between-thinking-and-non-thinking-modes-via-user-input)。GLM Schema 明确列出 enable_thinking；Qwen Schema 未列出该参数，所以不能仅凭请求被接受就认定硬开关可正常使用。

## 同组 28 条重测

使用原脚本与冻结样本，不修改期待值、不删样本、每条一次，不重试。保持默认 8 秒超时、8192 估算输入 token、1024 输出 token、近期 6 个用户轮次。两模型顺序执行完整批次；3 个既有复合场景仍要求完整动作序列。样本 SHA256：

`b95acc289b828291a2fffce8780100991408cddeeb11eb4236a49ad2d347deca`

| 模型 | 修复前通过 | 修复后原 16 例 | 修复后新增 12 例 | 修复后总计 | 超时前→后 | 错误控制后 |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen3-30B-A3B | 8/28 | 5/16 | 6/12 | 11/28 | 3→0 | 2 |
| GLM-4.7-Flash | 0/28 | 8/16 | 8/12 | 16/28 | 26→5 | 1 |

| 模型 | 修复前 P50 / P95 | 修复后 P50 / P95 | 本轮原因统计 |
| --- | --- | --- | --- |
| Qwen | 3368 / 8011 ms | 1119 / 1962 ms | 20 accepted、6 needs_visual、1 invalid_result、1 incomplete_target |
| GLM | 8007 / 8016 ms | 1935 / 8012 ms | 22 accepted、5 timeout、1 incomplete_target |

accepted 仅表示通过协议和已有目标校验，不等于场景正确。本轮 Qwen 28 次响应均为 HTTP 200；GLM 23 次 HTTP 200，5 次超时无可核对的响应。已收到的响应均无非空 reasoning。延迟包含网络和失败，单批不能用于性能保证；GLM 剩余超时不能归因于思考、排队或网络中的某一项。

Qwen 原来的 9 次 invalid_result 降为 1 次；本轮这 1 次是把同一原文跨度重复用于 request 和 supplement，被原校验整体拒绝。没有出现原先 forbidden target/candidates 字段导致的拒绝，没有剥除错误字段或放宽校验。

语义问题仍明显：Qwen 把 6 条纯文字输入判为 needs_visual，多处把已有工作补充当作新请求；两模型都把无明确对象的“那个先别做了”直接取消 report，Qwen 还把不存在的视频压缩任务映射到 report。GLM 对真实回复和同主题工作仍会误判，并在“停止图表、报表继续”中多输出一个新请求。incomplete_target 是有效保护，但预期澄清没有发生，因此仍记失败。

**调用修复有效，但两者当前都不适合自动控制任务。** 错误目标即使是已提供的真实 ID，也不能被现有 ID/状态校验自动发现。没有将任何合成动作交给执行器，没有更改运行中的 Bot 或本地模型选择，没有恢复 Clef、启动 Telegram/herdr 或新增 workspace。

## 验证与证据

- 分类器 9/9 测试通过：验证 SDK 实际出站参数、各动作 Schema、专用参数仅用于对应官方端点、Schema 预算不足时不发送、reasoning-only 不成为控制，以及原有跨度/目标/完整性拒绝。去掉协议参数或预算计入会使新增对应测试失败。
- 全仓 `node --import tsx --test --test-concurrency=4 test/*.test.ts`：196/196 通过。日志 `C:/Users/Cx/AppData/Local/Temp/nailong-cf-controls-tests-20261017.log`。
- `npm run typecheck`、`npm run build` 通过，验收脚本独立严格 TypeScript 检查通过。
- `npm run docs:check`：93 篇跟踪文档、340 个本地链接通过；`git diff --cached --check` 通过。
- 两次 API 批次均因有样本未通过而退出 1；不是脚本崩溃，也没有补跑后改记成功。

本机原始请求/响应、快照、逐例结果及汇总：

- `C:/Users/Cx/AppData/Local/Temp/nailong-cf-qwen-routing-controls-20261017/`
- `C:/Users/Cx/AppData/Local/Temp/nailong-cf-glm-routing-controls-20261017/`

极小接口探测保存于同一临时目录下的 `nailong-cf-controls-probe-{qwen,glm}-20261017.json` 和 `nailong-cf-qwen-{schema-default-thinking,no-schema-disabled-thinking,json-object-default-thinking}-20261017.json`。这些证据只含合成内容、请求正文和响应，不保存密钥、请求头或账户 URL。旧批次证据没有覆盖。
