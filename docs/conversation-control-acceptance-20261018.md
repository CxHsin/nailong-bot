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

以下仍需实际 Magpie 与 Telegram 手机配合，保持未验收：

- 在 Agent 页面人工核对 Nailong 的检测、连接状态与共享配置路径；插件安装及配置读取已有上述证据。
- Telegram 选择后在 Magpie 菜单回显；Magpie 修改后在 Telegram 回显；刷新不覆盖选择。
- 忙时切换、思考等级实际请求、重启、连接关闭与恢复。
- 手机上的工作详情、取消/继续、reset 确认、草稿与最终文件交付。

因此 #244 的真实链路验收尚不完整。模拟网关通过不能替代以上结果，也不能把本地代码提交视为生产部署或 Issue 已关闭。
