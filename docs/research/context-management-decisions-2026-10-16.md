# 上下文管理与分层记忆讨论

日期：2026-10-16。状态：讨论进行中；下列确认项不是完整规格，也不表示已实现。当前生产基线为 `7224023`，主执行器使用 Pi Durable 1.2.0，见 [ADR-0011](../adr/0011-durable-main-agent-and-conversation-queue.md)。

## 目标与材料

本轮覆盖 prompt cache、输入顺序、长工具结果卸载、视觉任务委派、上下文压缩与分层记忆。课程参考为《常驻主动型智能体如何工作》笔记第五章，PDF 文件页 22–26：`D:/Course/Paper/outputs/常驻主动型智能体/常驻主动型智能体如何工作_notes.pdf`。课程规则与参数是参考，不自动成为本项目约束。

此前记忆讨论见 [持久化工作流与记忆系统讨论](persistence-memory-decisions-2026-10-15.md) 与 [Akasha 调研](akasha-personal-memory-2026-10-12.md)。跨天、压缩或 reset 后找回经历与决策原因仍是目标；执行进度由 Durable 保存，不依赖语义记忆推断已执行操作。

## 本轮已确认

- 用户接受稳定画像，要求参考 Akashic Agent 的治理；这更新了此前“不生成稳定偏好档案”的设计边界。进一步确认允许 SELF 维护对用户的理解和关系定义，依据用户原话更新、当前表达优先；奶龙基础人设继续由 system prompt 定义。
- 本轮 tool prune 指：工具结果过长时，保存完整结果，模型接收受限视图和文件引用，后续使用 `read` 分页查询，不能以一次完整读取将卸载内容重新灌回上下文。每页有大小限制并提供继续读取的位置；需要更多内容时按页追加。没有确认每轮删除历史结果或动态删减工具定义。
- 用户同意：连续截图、批量图片和较重的视觉子任务优先交给独立 helper；简单的用户图片问题由主 agent 处理。helper 回传结论、证据与文件位置，主 agent 按需复看。
- 用户确认采用“常驻 Markdown 档案 + 主题自动浮现 + Akasha 原文召回”，三路分别控制预算、去重；主动搜索和原文读取保留。此决定没有确认上游图内核的具体版本与参数。
- 用户确认 system 记忆快照固定到下一次压缩或 reset，并持久保存，进程重启复用实际快照。期间新增记忆和纠正以追加材料进入当前上下文，新纠正立即生效。
- 用户确认压缩后后台从原始对话提炼记忆；明确要求记住、纠正或忘记时立即更新。画像与关系判断必须引用用户原话；helper 提交候选，由主助手统一写入共享记忆。
- 用户确认“忘记”默认删除对应画像条目、禁止相关来源再次自动召回，保留原始对话记录；明确要求“彻底删除”时再处理原始记录。此确认不表示已选定原始记录的物理删除实现。

## Akashic 当前事实

源码固定为 [`c1dc17ffaf6365db289efe4cb6897e46b8ba2f41`](https://github.com/kachofugetsu09/akashic-agent/tree/c1dc17ffaf6365db289efe4cb6897e46b8ba2f41)，本次为静态源码核对。

- 材料贡献者并行准备，之后确定性合并；不存在“先完成 Markdown 组装，再用它触发 Akasha”的依赖。[材料汇总](https://github.com/kachofugetsu09/akashic-agent/blob/c1dc17ffaf6365db289efe4cb6897e46b8ba2f41/plugins/context/materials.py#L81-L121)
- Markdown system 材料按 session 与最新 compaction reference 缓存：使用规则、SELF、MEMORY、当前项目与全局主题的 pinned 正文和 description 索引。新用户 Input 还可触发 BM25 主题浮现，放在 reminder，后续工具步骤复用。[快照与浮现](https://github.com/kachofugetsu09/akashic-agent/blob/c1dc17ffaf6365db289efe4cb6897e46b8ba2f41/plugins/markdown_memory/plugin.py#L679-L729)
- Akasha 用当前 open turn 的最新真实用户输入检索，首次查询记录包括零命中；工具续步与重启复用已保存查询。它不以 Markdown 内容作为 query。[检索触发](https://github.com/kachofugetsu09/akashic-agent/blob/c1dc17ffaf6365db289efe4cb6897e46b8ba2f41/plugins/akasha/runtime.py#L131-L169)
- Markdown 快照缓存是进程内字典，最多 64 个 key；淘汰或重启后会从当前文件重建。因此同代稳定不是跨重启持久保证。
- MEMORY 保存用户事实、偏好、明确要求长期记住的内容；SELF 保存人格与形象、对用户的理解、关系定义；topics 保存全局及项目主题。[结构与用法](https://github.com/kachofugetsu09/akashic-agent/blob/c1dc17ffaf6365db289efe4cb6897e46b8ba2f41/plugins/markdown_memory/documents.py#L320-L384)
- 后台从已使用压缩摘要所覆盖的精确对话提炼，支持 add、supersede、retract。用户事实与关系判断以真实用户消息为证据，不能使用助手转述、工具输出或摘要代替。用户明确要求记住或忘记时，主 agent 可立即编辑文件；现有 system 快照随后才刷新。[提炼规则](https://github.com/kachofugetsu09/akashic-agent/blob/c1dc17ffaf6365db289efe4cb6897e46b8ba2f41/plugins/markdown_memory/plugin.py#L459-L477)
- 后台整理、超额剪枝保留操作与恢复记录；原生文件工具和外部编辑器不参与后台文件锁，不能宣称所有写入都有同等校验。[现行手册](https://github.com/kachofugetsu09/akashic-agent/blob/c1dc17ffaf6365db289efe4cb6897e46b8ba2f41/_handbook/memory-markdown.md)

## 视觉委派的拟议实现

以下为实现建议，尚未实施：

1. 在 MCP 接入处区分 text、image 和资源引用。当前 [mcp-catalog.ts](../../src/agent/mcp-catalog.ts) 将非 text 内容 JSON 序列化为文本，图片 base64 会进入主上下文。图片应先落文件，主模型仅收到带来源的引用。
2. 一个完整视觉子任务复用一个 helper 会话，由 helper 自己持有浏览器任务、导航、截图和观察。现有登录 tab 的共享须核对连接器能力，不能假定主助手与外部 CLI 共用浏览器会话。
3. 通过已有文本 prompt 传递任务和图片 manifest，列出图片路径、顺序及来源；helper 用自身图片读取能力查看。herdr 当前 prompt 命令没有图片附件参数，不需要另造图片传输协议。
4. 复用现有 herdr_watch、内部结果队列和真实身份恢复。helper 写简短报告并给出证据路径，主 agent 按需 `read` 指定图片，不把全部截图自动回填主上下文。
5. 用户输入与原始资料保留；给模型的输入视图可使用文件引用。批量图的识别与路由须发生在主模型收到完整图像之前。

## 待决

- 画像具体字段与预算、记忆变更的来源及恢复记录；遗忘对当前快照和摘要的处理，以及“彻底删除”的具体范围。
- 稳定输入的具体段落顺序、各召回通道的实际位置与去重；快照和追加材料的存储及恢复接口。
- 长结果阈值、保留片段、归档寿命及统一覆盖哪些工具；分页的页大小和超长单行处理；图像原件的存储和读取路径。
- 压缩的保留内容、触发参数、可恢复来源与验收场景；缓存按实际 provider 请求和 usage 验证。

完整设计确认后按 [Issue tracker 约定](../agents/issue-tracker.md) 发布结论 Issue；涉及真实架构取舍时记录 ADR。
