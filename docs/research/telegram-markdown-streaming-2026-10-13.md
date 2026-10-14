> 2026-10-14 历史记录：本文的旧 Host/Task、权限与结算、记忆或实验行为已从在线入口退役。当前行为见 [ADR-0010](../adr/0010-native-pi-assistant.md)；当时证据保留，不能作为新版保证。源码基准为 727a294293463332e55558fa3e5ba518719d6890。

# Telegram Markdown 渲染与流式输出接口

调研日期：2026-10-13（Asia/Shanghai）。检查 Telegram 官方在线 Bot API 文档、变更日志，以及本地已安装的 grammY 类型定义。当前官方版本为 Bot API 10.3（2026-08-24）；仅查阅资料，未向真实 Telegram 会话发送消息。

## 结论

当前个人私聊可直接采用 **`sendRichMessage` 渲染 Markdown、`sendRichMessageDraft` 预览生成中的正文**。标题、列表、代码块和截图中的管道表格均有原生支持，不必先把表格转图片。Rich Markdown 尽可能兼容 GFM，但不保证任意 Markdown 扩展或 HTML 都兼容。

| 用途 | 接口 | 适用范围与限制 |
| --- | --- | --- |
| 正式 Markdown 回复 | `sendRichMessage(chat_id, { markdown })` | 支持私聊、群及频道等正式消息目标；返回 Message |
| Markdown 流式预览 | `sendRichMessageDraft(chat_id, draft_id, { markdown })` | 仅私聊；返回 True，草稿不是正式交付 |
| 传统文字流式预览 | `sendMessageDraft` | 仅私聊，支持 parse_mode/entities，0–4096 字 |
| 群聊渐进更新 | 发消息后 `editMessageText` | 支持 rich_message 参数；属于反复编辑已有消息 |
| 传统文字格式 | `sendMessage` 的 MarkdownV2/HTML/entities | 支持粗体、代码等文字实体，没有原生表格；GFM 的双星号粗体也不能直接当作 MarkdownV2 使用 |

来源：[sendRichMessage](https://core.telegram.org/bots/api#sendrichmessage)、[sendRichMessageDraft](https://core.telegram.org/bots/api#sendrichmessagedraft)、[sendMessageDraft](https://core.telegram.org/bots/api#sendmessagedraft)、[editMessageText](https://core.telegram.org/bots/api#editmessagetext)、[传统格式](https://core.telegram.org/bots/api#formatting-options)、[最新变更](https://core.telegram.org/bots/api#recent-changes)。

## 格式与长度

InputRichMessage 的 `markdown`、`html`、`blocks` 必须三选一。Rich Markdown 支持标题、列表、任务列表、管道表格、代码块、脚注及公式；也可显式传入结构化块。

富消息限制为：最多 32768 UTF-8 characters（官网原文，含 emoji 替代文本及公式源码）、500 块（计入嵌套块、列表项、表格行等）、16 层嵌套、50 个媒体附件、表格最多 20 列。表格单元格仅支持行内格式。分页需要按结构处理，现有固定字符切片可能截断代码围栏或表格，不能直接沿用作为富消息分页保证。

来源：[InputRichMessage](https://core.telegram.org/bots/api#inputrichmessage)、[富消息格式与限制](https://core.telegram.org/bots/api#rich-message-formatting-options)、[Rich Markdown](https://core.telegram.org/bots/api#rich-markdown-style)、[表格块](https://core.telegram.org/bots/api#inputrichblocktable)。

## 流式预览语义

草稿是 **30 秒临时预览**。生成结束必须调用 `sendRichMessage` 或 `sendMessage` 正式保存。草稿更新返回 True，不能记为 Delivery 已发送，不能用来触发记忆学习或建立正式消息回复关联。

`draft_id` 必须非零，同一 ID 的更新呈现动画；每次发送累计的当前内容，不是仅发送新增 token。`message_thread_id` 可选，普通私聊无需开启 topics。2026-03-01 Bot API 9.5 已明确允许所有 bot 使用 sendMessageDraft，早期仅支持特定 topics bot 的资料不能作为当前限制。

两种草稿都支持 `can_stop` 和 `keep_on_stop`；停止按钮会产生 `stopped_message_generation` Update。即使保留部分草稿，仍会消失；正式保留需另发消息。只有接好实际生成取消与任务范围后才应打开停止按钮。Rich 草稿不支持直接上传新文件或通过 URL 显式上传文件。

来源：[富消息草稿](https://core.telegram.org/bots/api#sendrichmessagedraft)、[文字草稿](https://core.telegram.org/bots/api#sendmessagedraft)、[2026-03-01 变更](https://core.telegram.org/bots/api-changelog#march-1-2026)。

需要合并增量、节流更新，遇 429 按 retry_after 回退。官方 FAQ 给出一般消息发送建议：单 chat 不超过约 1 条/秒、群 20 条/分钟、广播约 30 条/秒；本次未找到 draft/edit 独立精确额度，不将这些数字当作草稿限额保证。

来源：[FAQ 限速](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)、[ResponseParameters](https://core.telegram.org/bots/api#responseparameters)。

## 调研时项目现状与接入建议

检查基准：`32fb3c1`，development。

- [Telegram Channel](https://github.com/CxHsin/nailong-bot/blob/727a294293463332e55558fa3e5ba518719d6890/src/personal/telegram.ts) 调用 `bot.api.sendMessage(ownerId, text)`，未传格式参数，因此截图中的 Markdown 被当作普通文本显示。
- [Channel](https://github.com/CxHsin/nailong-bot/blob/727a294293463332e55558fa3e5ba518719d6890/src/personal/channels.ts) 订阅正式 Delivery，默认按 3500 个 Unicode code point 分页，保存各页 sent/rejected/unknown；发送未知不自动重发。
- [Pi prompt](https://github.com/CxHsin/nailong-bot/blob/727a294293463332e55558fa3e5ba518719d6890/src/personal/pi.ts) 当前订阅 message_end 统计用量，等待 prompt 完成后收集文字；没有把正文增量向 Channel 暴露。
- package.json 使用 grammY `^1.46.0`；本地安装的 core/api.d.ts 已有 sendRichMessage、sendRichMessageDraft、sendMessageDraft，@grammyjs/types 已有 InputRichMessage，无需因这些方法缺失手写 HTTP 请求。部署时仍应核对实际安装版本。

建议正式回复改用 Rich Markdown，并将格式感知分页放在 Telegram Channel。需要增加 Pi → Host → Channel 的公开正文预览通路；传输适配继续归 Channel，执行与任务状态继续归 Host。只预览当前面向用户的回复，不能把 thinking、工具参数或后台子任务的全部输出直接推送。草稿累计快照按回复身份隔离，并处理未闭合 Markdown、取消、失败和正式发送的竞态；客户端具体表现需实机验证。

最终回复继续通过持久 Delivery 正式发送，只有成功返回 Message 后记录 providerMessageId。草稿失败可以降级到正式回复，不得把临时预览算作成功交付。

ADR-0007 历史正文选择过 plain Telegram 并替代 drafts；本次提出恢复富格式与草稿，是对该输出选择的调整，实施时应更新当前说明。ADR-0008 的 Host/Channel 职责、选择性后台汇报和未知发送不重发保证应继续保留，不能为流式显示绕过。

来源：[当前上下文](../../CONTEXT.md)、[ADR-0007](../adr/0007-personal-host-native-sessions.md)、[ADR-0008](../adr/0008-personal-agent-orchestration-direction.md)。

本轮仅完成接口调研；真实 Telegram 渲染、客户端兼容性、草稿刷新频率、停止按钮及重启/失败行为尚未验收。

后续实现（#174）已在 development 接入富消息与正文草稿；以上源码现状描述保留 `32fb3c1` 调研基线，当前行为和验证边界见 [操作说明](../personal-agent-operations.md#telegram-回复渲染与预览174)。
