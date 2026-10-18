# 会话控制面板与 Magpie 接入验收

日期：2026-10-18。规格 [#244](https://github.com/CxHsin/nailong-bot/issues/244)，设计 [ADR-0016](adr/0016-magpie-catalog-and-conversation-settings.md)。实现任务为 [#245](https://github.com/CxHsin/nailong-bot/issues/245)、[#248](https://github.com/CxHsin/nailong-bot/issues/248)、[#246](https://github.com/CxHsin/nailong-bot/issues/246)，交付与验收由 [#247](https://github.com/CxHsin/nailong-bot/issues/247)跟踪。实现前基准为 `4c2aa62`，集成分支为 `development`。

## 自动化行为入口

测试通过真实 `createAssistant`、`connectTelegram`、grammY `Bot.handleUpdate()`、Queue System、SQLite 与 Pi Durable 运行。进程外替身提供 Telegram Bot API、HTTP 模型端点和 Magpie 目录；配置使用实际 JSON 编解码，重启重新创建服务和 Telegram channel。模型及工具中的 Promise 闸门明确请求边界。验证观察 Telegram 输出、真实 HTTP 参数、文件效果、配置回写和重启事实。

| 行为 | 证据入口 |
| --- | --- |
| 无模型接收并持久等待、重启后明确选择继续 FIFO | `assistant-model-control.test.ts`、`assistant-control-panel.test.ts` |
| 完整多层 ID、分页、详情、常用、刷新失败保留与成功移除 | `assistant-control-panel.test.ts` |
| 双端明确选择、回写回声、刷新及重启不覆盖、其他 Conversation 独立 | `assistant-magpie-sync.test.ts` |
| 挂住 A 请求，选择 B/C，当前 A 保持、后续实际请求采用 C；工具仅执行一次 | `assistant-model-control.test.ts`、`assistant-control-panel.test.ts` |
| 有限预算共四次，切换不重置；暂停只换设置不恢复，明确继续且重复去重 | `assistant-model-control.test.ts` |
| medium/low/最低/未知/非推理及扩展等级，能力变化、reset 和重启恢复 | `assistant-model-control.test.ts` |
| 较小窗口原生压缩后续接；图片能力不足暂停，保留原图并明确继续 | `assistant-magpie-sync.test.ts`、`assistant-model-control.test.ts` |
| 真实工作详情、指定目标取消及其他工作 FIFO、回调鉴权与去重 | `assistant-control-panel.test.ts`，已有 helper/routing/recovery 回归 |
| 忙时模型/缓存/收藏/草稿独立，reset 确认及取消，重启命令去重 | `assistant-control-panel.test.ts` |
| 真实流式预览关闭后不更新，最终文本、文件及 receipt 正常 | `assistant-control-panel.test.ts` |
| 正式 CLI 无旧主模型配置、同目录独占、选择后恢复、intent 独立校验 | `assistant-cli.test.ts` |

测试文件位于 [test](../test/)。完整回归、类型、构建与文档检查结果在最终受检状态稳定后记录。历史验收继续适用于其原日期与提交，不用于证明新增能力。

## 真实 Magpie 只读证据

本机 `GET http://127.0.0.1:3425/api/hello` 返回 Magpie **0.1.1285**。认证目录 `GET /v1/models` 使用 Nailong 客户端身份，返回 **HTTP 200、30 个模型**；本次没有发送模型生成请求或更改运行配置。

真实目录的 `supported_reasoning_levels` 为 `{effort: string}` 数组，`reasoning_levels` 为字符串数组，两种表示在 30 项中一致。等级全集为 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`，每个模型只使用其自身集合。有 1 项缺 `context_window`、1 项缺 `max_output_tokens`、3 项缺 `modalities`，面板仍显示未知。实际目录查询支持解析契约，不证明逐模型可调用或真实插件同步。

固定接口依据为 Magpie `d783df46cbac9021e26a6bd71ca0b55544552eb2`：[插件描述](https://github.com/yetone/magpie/blob/d783df46cbac9021e26a6bd71ca0b55544552eb2/internal/agentplug/agentplug.go)、[配置与模型读回](https://github.com/yetone/magpie/blob/d783df46cbac9021e26a6bd71ca0b55544552eb2/internal/agent/plugged.go)。`prefix` 为直接拼接，模型引用使用 `magpie/` 加完整目录 ID。运行版本查询不代表已确认其二进制构建提交。

## 尚未完成的真实链路验收

已查常规插件清单未发现 Nailong，默认 Nailong 连接文件也不存在；没有对未知自定义安装位置作全面检查。当前网关端口的 GUI `GET /api/plugins` 返回 404，不能当作插件列表 API 已验证。没有安装插件、更改 Magpie 连接、重启生产 Bot 或消费 Telegram 更新。

以下仍需实际 Magpie 与 Telegram 手机配合，保持未验收：

- 安装仓库 Agent 插件并在 Agent 页面检测、连接，核对共享配置路径。
- Telegram 选择后在 Magpie 菜单回显；Magpie 修改后在 Telegram 回显；刷新不覆盖选择。
- 忙时切换、思考等级实际请求、重启、连接关闭与恢复。
- 手机上的工作详情、取消/继续、reset 确认、草稿与最终文件交付。

因此 #244 的真实链路验收尚不完整。模拟网关通过不能替代以上结果，也不能把本地代码提交视为生产部署或 Issue 已关闭。
