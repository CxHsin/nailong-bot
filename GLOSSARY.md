# Nailong Personal Agent

持续处理个人对话与工作的助手。以下术语描述本项目的领域概念。

## 助手与交互

**Personal Agent**: 与用户持续共事的主助手；编码是其能力之一，可以委派给外部帮手。

**Assistant Service**: 协调输入输出、会话、队列、执行与辅助材料的本地服务。

**Channel**: 认证外部输入并交付文字、图片与文件的渠道。

**Conversation**: 持续对话的稳定身份，关联主 Session、工作目录及会话偏好。

**Session**: 一个 Conversation 中主助手的模型上下文；上下文重置与工作取消是不同操作。

**Work Directory**: 当前工作的默认目录，也是相对路径和项目指令的解释范围；它与 Session 存储位置不同。

**Conversation Control Panel**: 查看 Conversation 状态、调整模型与思考偏好、操作现有工作的统一交互入口。

**Model Catalog**: 已连接模型服务提供的可选模型及其已知能力集合。

**Routing Model**: 根据输入及工作上下文提出 Routing Actions 的模型，其选择独立于主助手模型。

**Persona Expression**: 主助手在可靠处理工作的同时，以奶龙的口吻和方式与用户互动。

**Satiety**: 投喂互动中的饱食状态；它不影响工作能力、准确性与可用性。

**Send Receipt**: 一次 Channel 发送的进行中、已发送、已拒绝或结果未知记录；它与用户工作的完成状态不同。

## 输入与工作

**Input Event**: 面向 Personal Agent 的外部输入。委派帮手的返回属于内部执行材料。

**Input Intent**: 用户在输入中表达的意思，包括独立请求、对已有工作的补充或取消。

**Queue System**: 管理输入路由、去重、会话选择与待处理顺序的系统。

**Processing Turn**: 主助手处理选定输入的一段执行，可以在委派后台工作后结束。

**Input Batch**: 按顺序选取的一组普通 Input Events，各自保留身份和消息边界；一个批次可包含多个独立目标。

**Work Target**: 一个独立用户目标的稳定引用，关联原始输入及其排队位置。

**Routing Action**: 从原始输入中识别的一项请求、补充、取消或澄清动作，具有稳定身份及投递进度。

**Event Priority**: 决定输入处理次序与抢占关系的优先级；直接用户输入彼此同级，高于后台输入。

**Work Supplement**: 用户对已有工作的补充或纠正，其目标通过上下文确定。

**Steering**: 将已识别的 Work Supplement 在支持的输入边界交给执行器的机制。

**Durable Workflow**: 持久保存的执行进度和已确认模型、工具结果，支持中断后续接工作。

**Paused Work**: 保留进度、等待明确继续或未知效果核实的工作。

**Delegation**: 主助手将工作交给外部帮手，并负责核查返回成果、推进完整用户目标的协作关系。

**Helper Observation**: 已派出帮手的真实身份、上下文及状态观察，用于将结果接回正确工作。

## 记忆与上下文

**Long-term Memory**: 有来源依据的跨轮记忆，包括用户事实、偏好、身份关系理解及全局或项目主题。

**SELF**: 助手身份、人设、相处原则，以及有来源的关系理解与表达习惯的权威定义。

**Akasha Recall**: 根据当前真实用户输入检索相关原始经历的过程，保留来源角色、时间和身份。

**Akasha Engine**: 支撑原始经历检索、关联与学习的机制；它与常驻档案和执行事实不同。

**Embedding Space**: 文本向量可相互比较的兼容语义空间；不同空间的向量与学习关联不能混用。

**Memory Snapshot**: 为一次上下文生成保存的实际常驻记忆材料，与当前可编辑档案不同。

**Tool Archive**: 可按稳定引用、来源或关键词找回并分页读取的工具输出原件。

**Default Forgetting**: 撤回派生记忆并将相关来源及其派生内容排除出自动召回与学习，保留原始记录；物理删除是另一项请求。

**Profile Maintenance**: 从有来源的对话提炼、合并和维护常驻档案的后台工作；容量退役与 Default Forgetting 不同。
