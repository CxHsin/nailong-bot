# Akasha 与 personal agent 记忆调研

调研日期：2026-10-12。问题：如何借鉴 Akasha，在持续理解用户时保留经历、变化与原话，避免把用户归纳为固定偏好；应用是否已经保证了这一点？

## 结论

**Akasha 理论拒绝把对话提炼成用户画像，但 Akashic Agent 应用同时维护另一套长期 Markdown 档案。不能把理论的原则直接当成整个应用的性质。** 图记忆、用户档案和后台职责是三个需要分别判断的设计。

- 理论的真相源是“用户或助手曾经这样说过”，不是“这句话客观正确”或“这个人永远如此”。它保存原文索引，学习原文之间的关联。[理论第三章、第二十三章](https://kachofugetsu09.github.io/memory/akasha.html)
- 当前应用的 `akasha` 插件仍以原始 Message 为召回出处；另一个 `markdown_memory` 插件提炼跨对话稳定的事实、偏好和明确要求，还维护对用户与关系的理解，并作为 system prompt 材料注入。这部分不符合本次讨论中拒绝固定偏好档案的方向。[档案生成提示](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/markdown_memory/plugin.py#L471-L488)、[档案注入](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/markdown_memory/plugin.py#L827-L854)
- 没有画像字段不代表没有偏置。理论主动强调“召回塑造回答、回答成为下一次记忆”的内容闭环；衰减、稀疏学习与连接预算缓和旧关联占据召回的问题，不能证明旧判断永远不会被重复强化。[理论第二十、二十一章](https://kachofugetsu09.github.io/memory/akasha.html)
- 记忆是背景材料，不能独立授予执行权限，也不能自动成为当前用户的新指令。应用的召回材料明确标注这一边界，实际行为仍需要模型与运行时配合。[召回渲染](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/recalls.py#L173-L201)

## 来源与核对范围

理论一手来源为作者的完整 [Akasha 理论页](https://kachofugetsu09.github.io/memory/akasha.html)，本次下载 HTML 并提取正文，按章节核对，包括召回、学习、自净化与边界。页面没有在本次提取中提供可核实的固定源码版本，因此以获取日期和章节定位，不推定它与应用当前提交对应。

应用一手来源固定在 [`556a14d311eb124ad7b0b522ba27a13898e5fe09`](https://github.com/kachofugetsu09/akashic-agent/tree/556a14d311eb124ad7b0b522ba27a13898e5fe09)。其 Akasha 内核来源记录为 `akasha-v2-engine` 的 `372672ba5575064a24f3bcf4eecd21050b0366c3`；本次核对应用仓库内镜像源码，没有运行或另行验证该外部内核仓库。[镜像出处](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/UPSTREAM.json#L1-L7)

本次是文档与源码静态调查，没有安装应用、调用 embedding/LLM、运行上游测试或复现博客案例。博客的真实库数字、心理学类比及“自净化”效果属于作者报告或设计解释，不作为本次独立验证结果。当前源码优先于带有历史迁移内容的说明文档。

## 理论：原话上的动态关联，而非固定资料卡

### 存储与粒度

第三章明确“不提炼记忆”：原消息不改写、不总结，一轮 user + assistant 形成 node，node 指向宿主原文。第四章用消息级与轮次级 embedding、FTS/IDF、新颖度基线建立索引。新颖度用于初始化差异，不是人格标签或事实真假判定。[理论第三、四章](https://kachofugetsu09.github.io/memory/akasha.html)

这个方案也不是只检索原文。原文是内容真相源，图和可访问状态是派生结构：同次被激活的旧记忆连边，旧记忆与当前轮形成不对称时序关联。理论把前向联系称为“因果边”，这里的计算依据是召回与时序，不足以证明现实中的因果关系。[理论第五、六章](https://kachofugetsu09.github.io/memory/akasha.html)

### 召回、学习与遗忘

理论描述 dense/FTS/高新颖度种子、局部 RWR、全图一跳扩展及 noisy-OR 型融合；注入分精确记忆与联想背景，学习只取融合得分最高的 8 项。原文指出，LLM 负责生成回答，算法用召回得分更新结构，不让 LLM 把猜测总结成新的用户事实。[理论第十一至十六章、第二十章](https://kachofugetsu09.github.io/memory/akasha.html)

理论参数为节点 strength 的 7 天衰减常数、边的 14 天衰减常数、resource 的 30 分钟恢复；这些是指数时间常数，不能称为半衰期。遗忘是降低参与计算的权重，原文仍可由直接相似检索唤回；用户要求删除则是另一种需要移除原文、索引、边与状态的操作。[理论第七、八、二十三章](https://kachofugetsu09.github.io/memory/akasha.html)

### 变化、矛盾与反馈风险

保留原话与时间让“以前喜欢、后来改变”有机会同时被看到；理论没有给出自动识别语义矛盾、判定新旧说法何者仍有效的专门算法。衰减判断的是可访问性，不是真假或撤销状态。[理论第八、二十三章](https://kachofugetsu09.github.io/memory/akasha.html)

第二十章明确召回改变回答内容，回答中的旧记忆影子又影响后续召回。这能形成共同经历的连续性，也意味着助手以前的误答可以参与未来上下文。保留 role 可防止来源混淆，但不能自动修正错误。[理论第二十、二十三章](https://kachofugetsu09.github.io/memory/akasha.html)

第二十一章提出 direct、衰减、有界增长、反 hub 和融合激活等防线。本次不能据此宣称“所有错误关联最终必然消失”：反复进入学习的误关联仍可能获得强化，相似文本也不等于正确证据。这是对算法能力边界的判断，而非作者保证。[理论第二十一章](https://kachofugetsu09.github.io/memory/akasha.html)

## 应用：图记忆与 Markdown 档案并存

### 当前图内核不是理论公式的逐项实现

当前 `MemoryCycle` 构建 burst-aware 种子后调用 residual-push diffusion 与 pattern completion；图以 episode hub membership 和前后向时序关系组织，并对被检索到的旧模式施加竞争学习。[检索流程](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/application/cycle.py#L129-L190)、[图学习](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/domain/graph.py#L404-L471)

| 维度 | 理论页描述 | 当前应用源码 |
| --- | --- | --- |
| 长期关联 | 旧轮之间共激活边、与新轮时序边 | episode hub membership 与 temporal forward/backward |
| 学习选择 | 融合 score 的 top-8 | 连续 activation field，经自适应稀疏投影与旧模式竞争学习 |
| 遗忘 | 固定 7/14 天指数时间常数 | 按历史复现学习 two-lognormal recurrence survival |
| 精确注入 | dense 与 ripple 分路 | 最多 5 个 dense turn，再加去重的 completion；两路各按时间展示 |

这些差异分别由 [当前活动场](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/domain/graph.py#L531-L558)、[保留函数](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/domain/graph.py#L473-L529)、[候选选择](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/recalls.py#L91-L142) 支持。这里只描述已核对实现，不断言哪一代效果更好。

### 原文学习、自动注入和主动检索

应用默认学习完整问答，多条输入可合为一个样本；只接纳完成且双方有文本的逻辑轮，session 学习资格、来源、suppress effect 可排除整轮。它不是先让模型人工挑选“重要片段”。[完整样本](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/projection.py#L127-L160)、[资格过滤](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/learning.py#L55-L86)

`prepare_materials` 用真实 session 前缀中的当前用户输入自动准备召回；同一输入后续工具续步与重启复用保存的记录，不凭空重写历史。[自动准备](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/runtime.py#L121-L189) 渲染时从 Message 读取完整正文，并记录作者、来源和召回通道；超字符预算的整条消息跳过，已展示消息有引用证据。默认配置是 12000 字符、context_recall_limit 40，但选择源码的两路预算分别处理，不能把配置值简单理解为最终两路合计恰好最多 40。[配置](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/config.py#L12-L35)、[选择与渲染](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/recalls.py#L116-L201)

应用还提供 remember/forget 反馈，按真实成功工具结果映射历史消息节点；不能把别的工具结果冒充 Akasha 反馈。forget 进入 inhibited set，remember 可解除抑制或强化；这比自然衰减更明确，但不是物理删除原文。[反馈验证](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/learning.py#L88-L135)、[反馈应用](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/application/cycle.py#L275-L299)

### 稳定偏好和明确长期要求确实在另一层

Markdown 插件的 prompt 要求 LLM 新增有用户原文引用的条目，保留“用户事实”“用户偏好”“用户明确要求长期记住的关键内容”；SELF 记录人格、对用户的理解、关系定义。它禁止用助手转述、工具结果、后台报告、召回或摘要代替用户原话，但仍是一套经过 LLM 提炼的档案。[生成合同](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/markdown_memory/plugin.py#L471-L488)

生成时要求不重写、不修订、不移动既有条目；验证器拒绝隐式删除。这能保护已有资料，不能据此证明对偏好变化和矛盾处理正确。新的纠正可能作为新增条目并存，但本次未做运行验证。[追加要求](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/markdown_memory/plugin.py#L471-L486)、[删除保护](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/markdown_memory/plugin.py#L572-L583)

明确长期要求被分为一个独立标题，但它与事实和偏好共处 `MEMORY.md`；本次核对没有证明它另有独立、可撤销、有权限范围的工作约定状态机。因此“保存明确长期要求”不能等同于“可执行的长期授权”。[schema 标题](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/markdown_memory/plugin.py#L77-L89)

`MEMORY.md` 与 `SELF.md` 会组成 system prompt，并注册为 priority 200 的 profile 材料；默认发行组合包含此插件且 context 选择它作为 prompt source，Akasha 插件也在默认组合中。运行选择仍由 `plugin-stable.json` 拥有，minimal overlay 可禁用两者，所以不能断言每个安装都启用了档案。[注入](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/markdown_memory/plugin.py#L827-L854)、[注册](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/markdown_memory/plugin.py#L929)、[默认组合](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/bundles/base.toml#L1-L139)、[minimal](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/bundles/minimal.toml#L116-L184)

## 主本体与后台：可借鉴结果回到主对话的闭环

应用子代理分 research、scripting、general，使用独立 session 与任务目录，携带 parent session/message lineage。general 子代理提示明确不直接与用户对话、不再创建后台子任务，结果回主本体。[任务建立](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/subagent/tools.py#L70-L95)、[子代理提示](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/subagent/prompts.py#L90-L100)

后台完成后，runtime 将结果作为带任务与来源身份的背景资料交给主会话 `REPLY_PROGRAM`，由 `CONVERSATION_COMPLETE` 组织主回复，再走 delivery。它明确标注“不是用户的新指令或用户事实”，且已有最终主回复时不因发送失败重复调用模型。这是本体接回结果的源码证据；仍不能据此宣称所有上层长期目标都自动继续直至完成。[回传实现](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/subagent/runtime.py#L261-L307)

Drift 手册另描述用户写技能定义的空闲后台工作，以及只属于 Drift 自身的观察，不作为稳定人格结论。它是可参考的产品安排，手册示例也包含“补足用户画像”，不应原样照搬到本项目。[Drift 指南](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/_handbook/drift-guide.md#L1-L81)、[画像示例](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/_handbook/drift-guide.md#L140-L166)

## 对 Nailong 的适用判断

本地现有 [CONTEXT.md](../../CONTEXT.md) 已定义 Akasha 为原始来源召回、图关联、排除与已送达轮次学习，并明确无稳定偏好档案。本地记录链路保留用户与已送达助手原话，由 memory_search 展示材料参与图学习；本地没有采用上游 Markdown 用户档案。这是本地对照，不是上游保证。参见 [src/personal/memory.ts](../../src/personal/memory.ts)、[src/memory/graph.ts](../../src/memory/graph.ts)、[src/memory/recall.ts](../../src/memory/recall.ts)。

本地同样没有先挑“重要片段”再存入：`recordDeliveredTurn` 记录整轮原始文本，已展示的召回片段用出处范围校验后参与最多 8 项学习。当前本地通过模型调用 `memory_search` 取得材料；上游还在模型调用前依据当前用户输入自动准备背景。是否增加自动召回是独立产品与上下文预算决策，不是恢复稳定偏好档案的理由。[本地记录与展示学习](../../src/personal/memory.ts)、[上游自动材料](https://github.com/kachofugetsu09/akashic-agent/blob/556a14d311eb124ad7b0b522ba27a13898e5fe09/plugins/akasha/runtime.py#L121-L189)

本次讨论已确认：当前问题与事实优先，历史只作相关背景；不从过去行为推定不可变的偏好。明确长期工作约定是否独立保存仍待讨论，用户暂时没有首个持续跟踪场景。不能为了补全架构而替用户发明一个长期职责。

由此建议保留原话、来源、时间与关联的方向；把召回看作对当下可能有帮助的候选，不把高分当真实性、当前有效性或权限。上游的后台结果返回主会话值得用于讨论委派闭环；上游的稳定用户档案应单独评估，不能因名字同为 Akasha 就引入。是否迁移 v2 内核需要另有质量、成本和变化处理证据，本次静态调研不足以决定。

后续可用三个真实或人工构造的场景验证：用户明确改口后能否看到变化而不继续当作旧偏好；助手误答是否仍以助手来源呈现、能否纠正关联；历史中的“以后帮我做某事”是否会在缺少当前有效授权时触发行动。这些是后续验收建议，本次没有运行。
