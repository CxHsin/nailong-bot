# 会话控制面板与 Magpie 接入验收

日期：2026-10-18。规格 [#244](https://github.com/CxHsin/nailong-bot/issues/244)，设计 [ADR-0016](adr/0016-magpie-catalog-and-conversation-settings.md)。实现任务为 [#245](https://github.com/CxHsin/nailong-bot/issues/245)、[#248](https://github.com/CxHsin/nailong-bot/issues/248)、[#246](https://github.com/CxHsin/nailong-bot/issues/246)，交付与验收由 [#247](https://github.com/CxHsin/nailong-bot/issues/247)跟踪。实现前基准为 `4c2aa62`，集成分支为 `development`。

## 自动化行为入口

测试通过真实 `createAssistant`、`connectTelegram`、grammY `Bot.handleUpdate()`、Queue System、SQLite 与 Pi Durable 运行。进程外替身提供 Telegram Bot API、HTTP 模型端点和 Magpie 目录；配置使用实际 JSON 编解码，重启重新创建服务和 Telegram channel。模型及工具中的 Promise 闸门明确请求边界。验证观察 Telegram 输出、真实 HTTP 参数、文件效果、配置回写和重启事实。

| 行为 | 证据入口 |
| --- | --- |
| 无模型接收并持久等待、重启后明确选择继续 FIFO | `assistant-model-control.test.ts`、`assistant-control-panel.test.ts` |
| 完整多层 ID、分页、详情、常用、刷新失败保留与成功移除 | `assistant-control-panel.test.ts` |
| 双端明确选择、回写回声、刷新及重启不覆盖、其他 Conversation 独立 | `assistant-magpie-sync.test.ts` |
| 全局断连在面板观察或实际发送前阻止独立会话续接；重连不自动恢复，明确继续复用工具效果；目录移除与能力变化传播到已有会话 | `assistant-control-panel.test.ts` |
| 挂住 A 请求，选择 B/C，当前 A 保持、后续实际请求采用 C；工具仅执行一次 | `assistant-model-control.test.ts`、`assistant-control-panel.test.ts` |
| 有限预算共四次，切换不重置；暂停只换设置不恢复，明确继续且重复去重 | `assistant-model-control.test.ts` |
| medium/low/最低/未知/非推理及扩展等级，能力变化、reset 和重启恢复；调整说明跨刷新和重启保留至明确选择等级 | `assistant-model-control.test.ts`、`assistant-control-panel.test.ts` |
| 较小窗口原生压缩后续接；图片能力不足暂停，保留原图并明确继续 | `assistant-magpie-sync.test.ts`、`assistant-model-control.test.ts` |
| 真实工作详情、指定目标取消及其他工作 FIFO、回调鉴权与去重 | `assistant-control-panel.test.ts`，已有 helper/routing/recovery 回归 |
| 忙时模型/缓存/收藏/草稿独立，reset 确认及取消，重启命令去重 | `assistant-control-panel.test.ts` |
| 真实流式预览关闭后不更新，最终文本、文件及 receipt 正常 | `assistant-control-panel.test.ts` |
| 正式 CLI 无旧主模型配置、同目录独占、选择后恢复、intent 独立校验 | `assistant-cli.test.ts` |

测试文件位于 [test](../test/)。历史验收继续适用于其原日期与提交，不用于证明新增能力。

## 集成阶段自动化验证

全部源码、夹具和测试写入者停写后，在 `development` 的 `0ba728859404eaac32ffb23b77c390d1e59bd108` 执行集成检查。下列证据对应该源码状态；随后本机接入修复及其新验证见下文。

- `npm test`：**206/206 通过**，0 失败、取消或跳过，约 71 秒。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run docs:check`：通过，107 份受跟踪 Markdown、454 个本地链接。
- `git diff 4c2aa62...HEAD --check`：通过。

断连缺陷的两个回归场景先在旧实现中观察到第二次 HTTP 请求，修复后均只有第一次请求；等级提示回归先在真实 Bot 页面中观察到说明缺失，修复后跨刷新和重启保留。对应定向组合测试 **7/7 通过**，已包含在最终全仓 206 项中。检查使用 Promise 闸门控制请求和工具边界；没有通过固定等待时间猜测结果。

## Standards

独立规范评审已复核当前说明、ADR 实现状态与验证证据，原目录到模型配置的重复映射已收敛。最终未解决项：**0 项 hard violation、0 项 heuristic smell**。

## Spec

独立规格评审发现的 P1（全局连接及目录未覆盖独立会话）和 P2（等级调整说明被内部读取消耗）已修复并复核通过。未发现范围扩张。最终未解决项：**1 项交付缺口，即下述真实插件与手机验收**；自动化通过不表示 #244 已全部验收。

## 真实 Magpie 只读证据

本机 `GET http://127.0.0.1:3425/api/hello` 返回 Magpie **0.1.1285**。认证目录 `GET /v1/models` 使用 Nailong 客户端身份，返回 **HTTP 200、30 个模型**；本次没有发送模型生成请求或更改运行配置。

真实目录的 `supported_reasoning_levels` 为 `{effort: string}` 数组，`reasoning_levels` 为字符串数组，两种表示在 30 项中一致。等级全集为 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`，每个模型只使用其自身集合。有 1 项缺 `context_window`、1 项缺 `max_output_tokens`、3 项缺 `modalities`，面板仍显示未知。实际目录查询支持解析契约，不证明逐模型可调用或真实插件同步。

固定接口依据为 Magpie `d783df46cbac9021e26a6bd71ca0b55544552eb2`：[插件描述](https://github.com/yetone/magpie/blob/d783df46cbac9021e26a6bd71ca0b55544552eb2/internal/agentplug/agentplug.go)、[配置与模型读回](https://github.com/yetone/magpie/blob/d783df46cbac9021e26a6bd71ca0b55544552eb2/internal/agent/plugged.go)。`prefix` 为直接拼接，模型引用使用 `magpie/` 加完整目录 ID。运行版本查询不代表已确认其二进制构建提交。

## 尚未完成的真实链路验收

初次只读检查时，常规插件清单未发现 Nailong，默认 Nailong 连接文件也不存在；没有对未知自定义安装位置作全面检查。当前网关端口的 GUI `GET /api/plugins` 返回 404，不能当作插件列表 API 已验证。当时没有安装插件、更改 Magpie 连接、重启生产 Bot 或消费 Telegram 更新。

随后用户在 Magpie 安装并启用了本地插件，已从真实插件清单读回仓库路径。补建默认配置目录后，真实共享配置已包含连接和模型选择。使用独立临时数据目录、真实连接配置和 30 项目录创建 Assistant，初始化通过，所选 `joye/deepseek-flash` 可用；本次没有连接 Telegram、消费消息或发送模型生成请求。这证明插件已安装且连接字段可供服务读取，尚未证明双端菜单回显和手机操作。

接入过程中发现目录中的 `deepseek-2/deepseek-reasoner` 声明上下文与最大输出均为 64,000，旧校验因要求上下文严格大于输出而阻塞整个目录的预注册。现允许二者相等，保留输出大于上下文及无效数值的拒绝。组合回归先复现相同错误，再验证其他模型请求、选择相等上限模型、重启与原上下文续接。独立 intent 配置校验通过，本地 Telegram 环境变量已更名为 `AGENT_TELEGRAM_*` 并核对值保持不变。

该接入修复基于 `ca52613`，修改 `src/agent/model-config.ts` 并新增一项 Telegram 组合回归。重新运行 `npm test` **207/207 通过**（0 失败、取消或跳过，约 70 秒）；`npm run typecheck`、`npm run build`、`npm run docs:check`（107 份 Markdown、454 个本地链接）及差异检查均通过。真实初始化证据和自动化测试分别记录，不把初始化成功视为生产 Bot 或手机验收通过。

用户随后在手机观察到点击按钮不断新增菜单消息。按原参考项目 [pi-telegram 的菜单更新路径](https://github.com/llblab/pi-telegram/blob/6b4db8a573416e2cbe60d44f6e38847cb6392348/lib/menu-model.ts#L390)和[工作菜单回调](https://github.com/llblab/pi-telegram/blob/6b4db8a573416e2cbe60d44f6e38847cb6392348/lib/menu-queue.ts#L795)核对后，修正按钮处理为编辑原消息的文字和键盘。主动输入命令仍发送新面板；同一消息的旧按钮在替换后失效，重复或过期回调只答复提示，操作失败也在原消息展示。使用新代码须重启 Bot 并发送新的 `/start`，旧面板不作为新代码已生效的证据。

新组合回归先观察到点击缓存后消息数由 1 变 2 的失败，再验证连续缓存、模型翻页、详情、收藏、选择、思考、草稿、工作和会话导航只保留一条菜单发送，后续均编辑相同 `message_id`；另验证失败操作原地显示且旧按钮失效。已有回调鉴权、重复取消与 reset、忙时切换、文件和 receipt 回归继续覆盖各自保证。手机端原地更新仍待运行新版后的实际确认。

该面板修复基于 `64824e2`。Telegram 相关回归 **36/36 通过**；全仓 `npm test` **209/209 通过**（0 失败、取消或跳过，约 71 秒）。`npm run typecheck`、`npm run build`、`npm run docs:check`（107 份 Markdown、454 个本地链接）及差异检查均通过。

随后按用户提供的原项目界面调整布局，基于 `187ac11` 核对 [pi-telegram 首页入口](https://github.com/llblab/pi-telegram/blob/6b4db8a573416e2cbe60d44f6e38847cb6392348/lib/menu-status.ts)和[模型列表](https://github.com/llblab/pi-telegram/blob/6b4db8a573416e2cbe60d44f6e38847cb6392348/lib/menu-model.ts#L1090)。首页采用模型、思考、工作、设置四组入口，当前值写入按钮；非推理模型隐藏思考入口。有待生效设置时正文保留实际请求与期望设置的区分。缓存、草稿与会话操作收在设置中；`/draft` 显示更新后的设置页。

模型列表正文不再重复列出本页全部模型及完整 ID，每个选择按钮独占一行并显示路由来源；默认点击仍立即选择。通过「详情与收藏」切换为详情入口，完整 ID、已知能力、选择和收藏操作仍可用，并保留返回页码。标题使用转义后的 Telegram HTML 加粗，缓存正文继续使用原样纯文本。工作列表用状态符号缩短按钮，详情仍显示真实状态及原有操作；本轮结束不表示成果已验收。

布局变更沿用既定行为测试，更新导航路径和呈现断言，没有为视觉文案另建测试。Telegram 相关 **36/36 通过**；最终全仓 **209/209 通过**（0 失败、取消或跳过，约 70 秒），类型、构建、文档（107 份 Markdown、454 个本地链接）和差异检查通过。期间一次全仓运行有原有进程强杀恢复测试超出 25 秒，结果为 208 通过、1 取消；该用例独立复跑通过，随后全仓重跑得到上述 209/209，未放宽测试时限。用真实 Bot 输出生成的五页静态布局预览不构成 Telegram 手机视觉验收；须重启 Bot 后确认客户端显示。

用户继续要求 `/stop` 暂停当前请求，并按截图补上 Status、Tokens、Cache、Context 四行摘要。此次变更基于 `8b9b682`。暂停命令走即时查询控制路径，先持久保存当前批次为暂停，再协作中断；迟到的执行结果不能覆盖暂停决定，未知外部效果仍保留 `needs_confirmation`。暂停跨重启保持，明确 `/resume` 才续接该批次；停止中立即收到 resume 时等待原执行释放后再恢复。其他排队输入仍可处理，helper 沿工作详情单独控制。Telegram 启动注册的命令菜单和共享帮助同时补上 `/stop`。

首页摘要按固定参考版本 [pi-telegram 的统计实现](https://github.com/llblab/pi-telegram/blob/6b4db8a573416e2cbe60d44f6e38847cb6392348/lib/status.ts#L1766)呈现：Tokens ↑/↓ 累计当前会话已结算主执行请求的非缓存输入/输出，Cache R 累计缓存读取，CH 取最近一条已结算请求的缓存读入/合计输入比例。请求 ID 替换 pending 记录，不重复计算；辅助压缩、记忆及其他会话不计入。累计用量按字段累加已知值，部分缺失的数值后加 `*`，并显示一行 `* 仅已知用量 · N 条缺失`；N 按缺少输入、输出或缓存读取任一项的请求去重计算，完整字段不加标记。完全没有已知值仍显示未知，已测量的零显示 0；不可解析的记录仍令累计不可用。CH 保留最近请求口径。Context 使用 SDK 对当前活动上下文的估算并标注 `~`，以实际模型目录窗口为分母；切换模型、reset 和重启后重新读取，不用累计输入替代占用。

2026-10-19，[修复 #258](https://github.com/CxHsin/nailong-bot/issues/258)补上历史失败/取消请求缺用量后的累计显示与首页标记。`node --import tsx --test test/assistant-cache.test.ts test/assistant-control-panel.test.ts` **35/35 通过**，覆盖按字段缺失、后续正常用量、零与未知、原请求去重和排除范围，以及 Telegram 首页跨重启显示。临时恢复“任一缺失使累计未知”的旧逻辑后，回归用例因实际 `null`、期望 `100` 失败；随后恢复修复。类型检查和文档链接检查通过。此验证使用受控 Telegram/模型接口，不代表运行中的 Bot 已加载新代码。

新增组合验证覆盖真实 HTTP 请求挂起时即时 stop、鉴权、暂停后重启与重复投递、显式 resume、无活动请求，以及多次工具请求的累计用量、最近请求命中率、当前上下文和窗口变化。队列用例验证迟到完成不能撤销暂停、停止中立即 resume、独立工作仍可运行与未知效果状态保留。强杀子进程用例停在暂停已入库但底层 abort 尚未送达的窗口，重启保持暂停，明确 resume 后才发送下一次真实受控 HTTP 请求。

回归有效性检查临时移除用户暂停的最终状态保护，观察到 `late result cannot undo user stop` 因实际 `completed`、期望 `paused` 而失败，随后恢复源码。最终受影响测试连同原恢复用例 **58/58 通过**；新增的强杀恢复用例和原取消强杀用例独立运行 **2/2 通过**。两次默认并行全仓检查都在原 `assistant-durable` 的 `confirmed` 子用例清理 SQLite 临时文件时遇到 Windows `EBUSY`（214 通过、2 失败，含父测试）；受影响复跑通过。定位到该用例 10 秒子进程边界等待耗尽后的 finally 发出 SIGKILL 就删目录，未等待进程释放 SQLite。已为这条清理路径补上退出等待，保留原断言与超时时限，最终全仓检查限制文件并发为 4，降低本机子进程启动竞争。

最终全仓命令 `node --import tsx --test --test-concurrency=4 test/*.test.ts` **216/216 通过**（0 失败、取消或跳过，约 113 秒），包含上述清理修正。类型检查、构建、文档链接检查（107 份 Markdown、454 个本地链接）及差异检查通过。新首页的静态预览由真实 Bot fixture 输出重新生成，仍不替代手机验收；运行新版须重启 Bot，启动会更新命令菜单，再发新的 `/start` 查看。

以下仍需实际 Magpie 与 Telegram 手机配合，保持未验收：

- 在 Agent 页面人工核对 Nailong 的检测、连接状态与共享配置路径；插件安装及配置读取已有上述证据。
- Telegram 选择后在 Magpie 菜单回显；Magpie 修改后在 Telegram 回显；刷新不覆盖选择。
- 忙时切换、思考等级实际请求、重启、连接关闭与恢复。
- 手机上的工作详情、取消/继续、reset 确认、草稿与最终文件交付。

因此 #244 的真实链路验收尚不完整。模拟网关通过不能替代以上结果，也不能把本地代码提交视为生产部署或 Issue 已关闭。

## 设置协调职责收拢（2026-10-19）

规格 [#251](https://github.com/CxHsin/nailong-bot/issues/251)，实现与验证任务为 [#252](https://github.com/CxHsin/nailong-bot/issues/252)、[#253](https://github.com/CxHsin/nailong-bot/issues/253)、[#254](https://github.com/CxHsin/nailong-bot/issues/254)。基准为 `5d779b1`，集成分支为 `development`。本次保留既有设置行为、公开入口与数据格式；当前职责见 [ADR-0016](adr/0016-magpie-catalog-and-conversation-settings.md)。上文真实双端回显和手机验收的状态沿用原记录。

既有 Assistant 与 Telegram 用例继续验证请求冻结、工具效果复用、后续 prepare 采用最终设置、全局连接与目录变化、FIFO、暂停显式续接、持久保存和旧协议注入。新增受控用例通过真实 Magpie 目录 HTTP 与临时 SQLite，在协调 module 的内部组合 seam 延迟或拒绝 Durable 配置，观察查询完成、配置结果、可运行性与关闭时机；不检查内部缓存或 Promise 集合。

| 迁移风险与观察结果 | 证据入口 |
| --- | --- |
| 查询等待其他 Conversation，等待期间新增的配置任务同样阻止查询完成 | `conversation-settings.test.ts` 的 `a query waits for other Conversations…` |
| 全局传播拒绝使查询拒绝并报告原错误；后续成功同步不被历史失败阻塞，不发送模型生成请求 | 同文件的 `a rejected global propagation…` |
| 初始 Magpie 观测不提前配置执行器；恢复时各会话采用已保存模型，配置完成后才通知可运行 | 同文件的 `restored Conversations…`；既有 `assistant-model-control.test.ts` 验证重启后的原输入 FIFO |
| drain 容纳拒绝和等待期间新增任务；idle 只等待调用时的当前任务 | `conversation-settings.test.ts` 的 `draining survives…` 与 `waiting for idle…` |
| stop 后不再通知路由放行，已开始配置仍收尾，排队与后来新增的同步拒绝仍被排空 | 同文件的 `stopping coordination…` |
| 真实 Assistant 关闭等待被延迟的目录读取，完成时不唤醒保存的输入；同目录重开后按原 FIFO 继续 | `assistant-runtime.test.ts` 的 `closing during settings propagation…` |
| Magpie 已建立但 Queue System 初始化失败时释放依赖，同目录可再次创建；历史配置快照、设置拒绝和实际请求保持兼容 | 同文件的 `failed Magpie queue startup…` 与 `historical model injection…` |

全部源码与测试写入者确认停写后，受检状态为 `5d779b1` 加本次暂存的协调 module、runtime 与测试差异；综合检查期间及完成后未再修改这些输入。新增 9 项测试，定向验证两个受影响文件 **16/16 通过**；新增断言验证已结束的历史失败在成功重同步前也不阻塞后续查询，定向复跑 **1/1 通过**。这是保持既有行为的覆盖补齐，没有将测试夹具的等待时机修正记为产品缺陷。

- `node --import tsx --test --test-concurrency=4 test/*.test.ts`：**225/225 通过**，0 失败、取消或跳过，约 103 秒。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run docs:check`：通过，107 份受跟踪 Markdown、458 个本地链接。
- `git diff --cached --check`：通过。

本次在 `development` 完成本地验证与提交；推送和 `development` → `main` PR 仍遵循用户明确授权流程。上述自动化结果不改变 #244 的真实双端回显和手机验收状态。
