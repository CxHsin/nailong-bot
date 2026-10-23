> 历史材料：下文的结论、状态与验证属于原文日期和基准。现行职责见[相关 ADR](../adr/0013-contextual-input-routing.md)，运行方式见[操作说明](../personal-agent-operations.md)；本地规格归档的权威版本仍为原文链接的 Issue。

# Cloudflare 通用小模型路由评测及 Clef 退役

本篇保留修复前基准。后续思考控制与 JSON Schema 调用修复及同组重测见[调用修复评测](cloudflare-routing-controls-evaluation-2026-10-17.md)。

后续审计确认：本轮样本 8、14 中仅包含助手消息的 recent 被组装器丢弃，因此第 14 例没有实际发送用于测试隔离的历史指令。原成绩仅反映当时实际输入，不能视作该历史上下文边界的有效验收；见[上下文修复](routing-three-context-evaluation-2026-10-17.md)。

2026-10-17（北京时间），用户要求复用现有 Cloudflare API Key，并删除 Clef 程序。任务 [#221](https://github.com/CxHsin/nailong-bot/issues/221)，关联 [#215](https://github.com/CxHsin/nailong-bot/issues/215)、[#220](https://github.com/CxHsin/nailong-bot/issues/220)。受检基准为 `d090d92` 加本次改动。

## 删除与当前入口

已删除 `intent-clef.ts`、Clef 配置分支、专用测试，以及 `clef-live.ts`、`clef-routing-live.ts` 两个验收程序。清理本地 dist 中对应的旧编译文件。分类运行时代码恢复为通用模型别名路径，与 `a235df2` 的 `intent.ts`、`environment.ts`、`runtime.ts` 一致；现有预算、原文动作、完整性、目标和执行前状态校验保留。

历史评测与临时证据保留，[双问题实验](clef-live-evaluation-2026-10-17.md)和[完整动作实验](clef-joint-routing-evaluation-2026-10-17.md)已标注退役并指向当时源码永久链接。当前配置入口见[操作说明](../personal-agent-operations.md)。原 16 例及新增 12 例转存为供应商无关的 `contextual-routing-cases.json`，没有删除样本来提高成绩。

新脚本 `scripts/acceptance/cloudflare-routing-live.ts` 通过现有 `createIntentClassifier` 和 Cloudflare [OpenAI 兼容接口](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)调用模型，读取本地已有的 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`。没有启动 Telegram、主 Bot 或 herdr，没有新增 workspace、切换 Bot 配置或执行样本中的控制动作；本地 `.env` 没有已启用的 Clef 配置项。

## 实测结果

每模型顺序运行同一组 28 例，每例一次、不重试。使用原分类器默认值：8 秒超时、8192 个估算输入 token、1024 个输出 token、近期 6 个用户轮次。原提示和校验未针对样本调优，未额外传 JSON 格式或供应商专用禁用思考参数。样本 SHA256 与前次 Clef 相同：

`b95acc289b828291a2fffce8780100991408cddeeb11eb4236a49ad2d347deca`

| 模型 | 原 16 例通过 | 新增 12 例通过 | 超时 | 其他失败 |
| --- | --- | --- | --- | --- |
| `@cf/qwen/qwen3-30b-a3b-fp8` | 5/16 | 3/12 | 3 | 9 次 invalid_result；4 次未决/错误 needs_visual；1 次 incomplete_target |
| `@cf/zai-org/glm-4.7-flash` | 0/16 | 0/12 | 26 | 2 次 classifier_error，无可供核对的 HTTP 响应 |

Qwen 返回有效路由的 11 例中，有 8 例严格通过；另外 2 例对已提供的真实回复仍多余澄清，1 例只返回复合消息中的取消，漏掉天气请求。9 次 invalid_result 均收到 HTTP 200、finish_reason=stop，失败主要是输出了该动作不允许的 target/candidates 字段，例如 supplement 也附带 candidates，新 request 也附带旧工作 target。程序保留整体拒绝，没有删除字段后假装通过。另有独立天气/翻译请求被错误兜底为需要视觉或不可判定。

Qwen 的“为什么季度收入图表还没有完成？”原始响应识别为 request，但附带 target=chart，因而整体拒绝；这是协议遵循问题，不能记成该例语义错误补充。已接收的控制动作未选错目标，但漏掉复合请求仍属于失败，不能用“错误控制为零”声称正确。

GLM 没有任何在默认时限内通过的结果，无法据此评分中文理解能力，也不能断定超时发生在网络、容量排队还是生成阶段。Qwen 的响应实际带有 reasoning 字段，通用配置中的 reasoning=false 只是当前客户端不发送 reasoning_effort，并不保证远端思考已禁用。后续若研究禁用思考或结构化输出，应作为独立参数实验保留本轮基准；本次不修改生产参数或提示来追求样本分数。

| 模型 | P50 | P95 |
| --- | --- | --- |
| Qwen | 3368 ms | 8011 ms |
| GLM | 8007 ms | 8016 ms |

延迟包括网络及失败，单批结果不作吞吐或性能排名。两模型脚本均因存在失败退出 1，非程序崩溃。

## 评分与证据

普通场景要求返回一个符合预期动作及目标。通用生成模型可以生成原文动作序列，所以 3 个复合场景要求完整返回：取消图表再天气请求、分别修改报表/图表、取消旧报表再新交办。仅识别 compound 或只返回第一项不算通过；这比旧 Clef 的“识别复合后完整兜底”要求更强，两者不能直接按总分排名。

本机临时证据：

- `C:/Users/Cx/AppData/Local/Temp/nailong-cf-qwen-routing-20261017/`
- `C:/Users/Cx/AppData/Local/Temp/nailong-cf-glm-routing-20261017/`

每目录含查询前的 cases.json、逐项 results.json、summary.json，保存实际请求正文、响应、快照、动作和原因，不保存请求头、密钥或账户 URL。超时请求可能已到达远端，没有自动补跑或改记成功。

```powershell
node --env-file=.env --import tsx scripts/acceptance/cloudflare-routing-live.ts <新的仓库外目录> qwen
node --env-file=.env --import tsx scripts/acceptance/cloudflare-routing-live.ts <另一个新的仓库外目录> glm
```

脚本拒绝覆盖已有目录；401/403/429 立即停止后续样本。现有 Key 可直接用于通用模型接口，但当前默认参数下两者均未达到可替换分类器的结果。

## 本地验证

- `node --import tsx --test --test-concurrency=4 test/*.test.ts`：193/193 通过，日志 `C:/Users/Cx/AppData/Local/Temp/nailong-cf-clef-removal-tests-20261017.log`。测试条数由 200 回到 193，是移除了 Clef 专用 7 项，通用路由、持久恢复、helper 和 Telegram 测试保留。
- `npm run typecheck`、`npm run build` 通过，旧 Clef 编译文件已清理。
- 新验收脚本独立严格 TypeScript 检查通过。
- `rg` 核对 src/test/scripts 和 `.env.example` 没有 Clef、专用 provider 或门槛配置残留；历史文档保留具名结果。
- `npm run docs:check`：92 篇跟踪文档、337 个本地链接通过；`git diff --cached --check` 通过。
