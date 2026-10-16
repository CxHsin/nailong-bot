# 上下文管理实现验收

日期：2026-10-16。规格 [#208](https://github.com/CxHsin/nailong-bot/issues/208)，实现任务 [#209](https://github.com/CxHsin/nailong-bot/issues/209)、[#210](https://github.com/CxHsin/nailong-bot/issues/210)、[#211](https://github.com/CxHsin/nailong-bot/issues/211)、[#212](https://github.com/CxHsin/nailong-bot/issues/212)。设计见 [ADR-0012](adr/0012-layered-memory-and-stable-context.md)，运行与预算见[操作说明](personal-agent-operations.md)。

本轮在 `development`、基准 `1548ed32fc187b349a6954b7af44e842855690a9` 上完成。已有未推送提交和无关材料保留；验收不包含生产部署、上游推送或合并。

## 实现边界

- Assistant Service 接收真实来源身份，准备持久记忆快照、每输入检索和增量材料；同代快照跨 reopen 保持实际内容，新共享记忆追加生效。
- [工具归档](../src/assistant/archive.ts)在首次续步前卸载长结果，复制 native shell spill 原件；已知引用分页读，未知引用有界搜索，索引不替代 Durable 执行事实。
- [记忆](../src/assistant/memory.ts)维护 MEMORY、SELF、全局/项目 topic、原话来源、版本、替代关系和遗忘规则。Markdown 是可读投影；原文召回采用本地词项/中文双字匹配，未导入旧 Host/Akasha。
- [遗忘过滤](../src/assistant/memory-context.ts)涵盖快照、原始历史、助手改写、已保存召回、追加材料及摘要；摘要来源包含 reset 后经快照进入的旧事实。受影响摘要从存活原文和 Durable 记录定位重建并保存，其他工作进度保留。
- [执行器](../src/assistant/durable-executor.ts)复用 Pi Durable 容量及后台压缩。有失效材料时，beforeCompact 提供清理后的摘要；清理请求失败则明确 decline，避免 SDK 忽略 hook 异常后使用旧原文。[后台提炼](../src/assistant/memory-refinement.ts)仅处理本次会话实际覆盖的有效用户原文，经相同治理边界写入。
- [媒体](../src/assistant/media.ts)在主模型输入前保存原件和有序 manifest；简单图保留 typed image，批量资料通过现有 herdr-workflow 交接，同一 helper 复用，主助手按需核验。

实际 OpenAI-compatible 编码：稳定 tools，system 中依次为 project、skills、memory、material-routing、必要的恢复提示，再由 SDK 放置 instructions；后续摘要、历史、原文输入和动态材料遵循 SDK 顺序。未绕过 provider 编码器。`requests.jsonl` 记录实际请求字节和可得的 provider usage，缺失指标为 null，不保存凭据或正文。

## 服务级验证

测试通过正式 `createAssistant`，实际 Pi Durable、HTTP 模型端点、工具和 SQLite 驱动输入，再检查实际 provider 请求、工具效果及 reopen 后行为。

| 用例文件 | 覆盖保证 |
| --- | --- |
| [assistant-archive](../test/assistant-archive.test.ts) | 首次卸载、错误/成功记录区分、搜索游标、UTF-8 长单行分页重组、累计进度、原件写入失败不重复效果、缺失/损坏/无命中区别、native shell 临时原件移除后仍可读 |
| [assistant-context](../test/assistant-context.test.ts) | 实际编码前缀及快照跨 reopen 不变、共享记忆增量、真实原生压缩续接、压缩原文提炼、排除其他会话证据、遗忘摘要重建与再次压缩 |
| [assistant-memory](../test/assistant-memory.test.ts) | MEMORY/SELF/topic 写入、真实原话校验、独立主题/原文通道、纠正和遗忘跨 reset/reopen |
| [assistant-memory-invalidation](../test/assistant-memory-invalidation.test.ts) | 助手改写不重新召回、跨会话无本地 forget 回执仍过滤、被替代来源不能重新写入、原生压缩后台学习不恢复旧偏好 |
| [assistant-media](../test/assistant-media.test.ts) | MCP text/image/resource 类型、批量素材先路由、30 图主输入有界、原件与顺序跨 reopen 保留 |

现有 FIFO、合批、steering、暂停/resume、helper 身份、文件交付、非导入历史、强杀恢复与未知外部效果用例一并回归。

缺陷复现：去掉来源传递/过滤，遗忘后的助手改写会重新召回；去掉摘要来源范围或清理接入，reset 后经快照进入的旧事实会留在 checkpoint；将清理失败改回抛异常，SDK 会继续原生压缩并读取失效原文；去掉后台提炼的会话范围检查，共享快照来源会破坏本次提炼。相应服务用例均先失败、修复后通过。

全部写入代理确认停写，最终源码稳定后完成综合检查：`npm run typecheck`、`npm test`（149/149，含新增 21 项服务测试）、`npm run build`、`npm run docs:check`（81 份 Markdown、263 个本地链接）及暂存差异检查均通过。完整测试日志保留在 `C:/Users/Cx/AppData/Local/Temp/nailong-context-final-tests.txt`。

双轴评审：Standards 的摘要进度丢失和快照版本解析问题已修复；Spec 的摘要失效、旧来源重新学习、助手改写重新召回和跨会话追加材料失效问题已修复。定向服务回归覆盖这些修复，并纳入最终 149 项全仓回归。

## 真实模型与 helper

原始证据根目录：`C:/Users/Cx/AppData/Local/Temp/nailong-context-live-20261016-061606/`。`evidence-review.json` 为导航，各场景的 `environment.json` 保存受测源摘要及模型身份，`scenarios.json` 保存实际回答，`metrics.json` 保存逐请求指标。首轮失败未覆盖或删除。

主模型为实际配置的 `deepseek-flash`，`openai-completions`，端点 `api.deepseek.com`。以下 input/output 与 cache 字段遵循各 provider 口径，表中 input 不被解释成包含缓存的统一总 token 数。

| 场景/证据目录 | 请求 | input / output | cache read / write | 场景耗时 | 实际结果 |
| --- | --- | --- | --- | --- | --- |
| `memory-final-run/` | 21 | 32639 / 5911 | 94336 / 0 | 52.7 秒 | 偏好、SELF、主题经 reset/reopen 可用；supersede 后新格式生效；forget 后再 reset/reopen 不复述两条旧格式，项目经历保留 |
| `project-final-run/` | 5 | 6384 / 1692 | 13568 / 0 | 15.2 秒 | 明确提供实际 cwd，topic 绑定该目录；reset/reopen 后同项目返回正确内容及相同 project/source 身份 |
| `materials-run/` | 7 | 6948 / 3353 | 24320 / 0 | 28.6 秒 | 20,234 字节工具资料首次续步只增加 5,039 请求字节；按需 archive_read 一页和简洁 helper 成果；三图仅抽读第 3 张核验纯蓝 |
| `compaction-run-2/` | 15 | 47086 / 6411 | 42496 / 0 | 40.0 秒 | 4 个真实 `pi.compaction` checkpoint（24/32/40/48）；close/reopen 后保留目标、Done/In Progress/Blocked、决策原因、下一步和资料路径 |

压缩验收仅降低客户端窗口为 16000，maxTokens=2048，reserveTokens=6000，keepRecentTokens=1200，backgroundTokens=0，端点和真实模型不变。首个 `compaction-run/` 使用 7000/1500 时受 SDK 固定输出安全余量影响，只返回 1 token、stopReason=length，没有 checkpoint；调整配置后才通过，未把首轮当作成功。

同一真实 Codex helper：thread `01a1435a-a38f-7b20-ba85-9e52ce3a6fd7`，GPT-6.1-Sol high，默认 herdr session，本任务 workspace/pane `wM:p1`。先分析 20,234 字节非视觉资料，三个事实正确；再实际通过 view_image 查看三张 32×32 PNG，红绿蓝与 manifest 顺序正确。两份回报 562/989 字节，终端活动时间约 27/35 秒。rollout usage：input 178620、cached input 156781、output 1783、reasoning output 35；与主模型口径分开报告。自建 pane 已关闭、workspace 自动移除，原 agent 不再存在；共享 herdr 主服务仍 running/compatible。

首轮真实记忆验收发现遗忘后仍复述旧偏好，促成助手派生来源过滤；自然项目名与 cwd 混用也被修正。最终记忆与绑定项目场景通过。其后执行器增加摘要范围中的快照/召回来源与清理失败 decline，后台提炼收紧会话范围；这些最终变化由服务回归覆盖，不把较早的真实运行源摘要冒称为最终完整代码树。

## 结论与适用范围

已验证主上下文受限视图、真实缓存 usage、跨 reset/reopen 记忆治理、原生压缩质量和独立 helper 成果交接。当前召回是关键词方案，不能据单次问答保证任意语义改述都命中；可用显式搜索与原文分页核查。视觉质量证据使用三张合成色块，未声称验证任意复杂截图或共享登录页面。

配置价格为零，费用不可得；未做同任务无委派的价格对照，不能据上述数据宣称全链路省钱。原始记录、归档无自动删除；默认忘记不承诺物理删除或备份清除。执行事实继续由 Durable 与外部核验决定。

重跑脚本：[context-live.ts](../scripts/acceptance/context-live.ts)。使用独立外部目录及现有模型环境运行，例如 `node --env-file=.env --import tsx scripts/acceptance/context-live.ts <独立输出目录> --compaction-only`；也支持 `--project-only`、默认记忆场景，以及带已有 helper 成果目录的 `--materials-only`。脚本使用真实模型调用，不自动创建新的 helper；外部 helper 通过 herdr-workflow 单独执行和验收。
