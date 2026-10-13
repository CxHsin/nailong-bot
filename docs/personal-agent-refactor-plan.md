# Personal Agent 首轮落地核验与改动计划

历史记录：本文保留 2026-10-12 的基准和当时证据，不表示 #167 统一工作流程已经实机复验。当前实现与未验证项见[2026-10-13 验收](personal-agent-acceptance-20261013.md)。

2026-10-12，核验基准 development cceb6b8；本文新增前 HEAD 为 cceb6b8。目标及已确认行为见 [ADR-0008](adr/0008-personal-agent-orchestration-direction.md)。这是实现前方案，不表示运行时已经迁移，也不替代现有 [ADR-0007](adr/0007-personal-host-native-sessions.md) 的当前实现说明。

## 核验结论

2026-10-13 已发布 [设计结论 #166](https://github.com/CxHsin/nailong-bot/issues/166) 和 [实现规格 #167](https://github.com/CxHsin/nailong-bot/issues/167)。后续以规格 Issue 为实现需求依据，本文保留实现前核验基准和证据。

保留 Host、Pi 原生会话、SQLite 任务账本及 Akasha。主要改动是本体直接行动、父子委派和结果续接、原生工具搜索 provider 适配、统一执行权限。无需迁移到 Pi Durable，不重建个人历史，不升级 Akasha v2。

### 原生工具搜索

安装的 pi-ai/pi-coding-agent 为 0.73.1。pi-ai 的消息类型没有原生搜索块、工具引用或 deferred 标记；OpenAI provider 把工具映射为普通 function，Anthropic provider 未传 defer_loading，二者均不能完整保存原生发现响应。请求补丁不足以解决解析和历史重放。

本项目 [model-config.ts](../src/agent/model-config.ts) 已有 toolSearch/nativeToolSearch 配置，[agent-models.ts](../src/agent/agent-models.ts) 返回 native 标记，但 [personal/pi.ts](../src/personal/pi.ts) 的会话创建没有落实原生搜索适配；不能把配置存在视为功能支持。

方案：在自定义 provider/stream 边界实现请求、流式解析和历史转换，保留 Pi agent loop。预注册当前工作可用的工具执行目录；provider 单独控制模型常驻定义及 deferred 目录。服务端搜索事件不作为普通本地工具调用执行；客户端搜索进入本地受控发现处理。工具实际派发始终检查工作身份、定义版本和授权。

版本化发现记录与对应消息位置持久保存，重放时恢复 API 原生结构；压缩移除发现记录或定义失效后重新发现。不要通过 setActiveToolsByName 模拟发现：它同时改变工具目录和 system prompt，而且正在执行的 loop 已复制工具数组。优先贯通客户端发现；自定义 streamFn 保留凭据、超时、重试和请求头行为，服务端搜索块在适配层保存顺序。Anthropic pause_turn 需要有预算地续请求，不能沿用当前 Pi 将其视为普通 stop 的行为。

协议依据：[OpenAI Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)、[Anthropic Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)。Anthropic 每次请求仍传完整 deferred 目录，OpenAI 客户端模式可动态返回定义；这与模型常驻前缀是不同层次。

必要验证：真实序列化请求中的常驻/deferred 区别；发现后实际执行；服务端搜索不重复本地执行；重启保持结构及顺序；压缩后重新发现；定义失效和越权调用拒绝；模型切换不串用原生协议记录。先用本地协议夹具验证，再对实际配置的兼容模型做最小真实调用。此次未调用真实模型 API，不认定代理端点支持原生协议。

### Windows 执行权限

本机 Codex 为 0.162.0-alpha.17.2，Windows build 26100.4652。官方 [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) 列出的 MXC 最低 24H2 build 为 26100.9278。本次显式 MXC echo 探测退出 1：native MXC is unavailable on this executor。

不更改保存配置的 unelevated 探测成功：echo 退出 0；在独立临时探测目录，工作目录内写入 allowed，父目录写入 denied，父目录读取 allowed。要求 root deny/minimal read 的权限配置被拒绝：Restricted read-only access requires the elevated Windows sandbox backend。一次初始配置引号错误已纠正，不能当作权限验证证据。

因此可复用 codex sandbox 作为候选命令后端，但本机已验证的 unelevated 仅提供写入边界，不能承诺读取隔离。elevated 尚未探测，不进行账户、ACL、防火墙或管理员设置变更；WSL/Docker 命令存在不证明隔离配置可用。Pi 官方 sandbox 示例仅支持 macOS/Linux，不能直接用于本机 Windows。

方案：定义执行后端能力（读隔离、写隔离、网络、进程树停止），按实际能力匹配工作权限。文件操作继续物理路径验证；MCP、Shell、外部编码执行各自落实边界。无法满足受限权限时停止派发，用户已明确授予该工作可信本机模式才可使用可信后端，不静默降级。

首轮先交付受控文件操作及明确的可信命令执行，再接入通过能力探测的 Codex 沙箱后端。允许部分隔离仅在其实际权限符合授权时使用；完整读取隔离在当前机器上仍待后端验证。对外发送、删除原件等语义规则不能仅由目录写权限实现。还需验证网络禁用、目录链接、子进程停止、超时与未知执行状态；本次文件探测不是完整沙箱审计。

### 委派与恢复

当前 [types.ts](../src/personal/types.ts) 的 Task 只有 local/herdr executor，[host.ts](../src/personal/host.ts) 的正常完成、重启对账和挂接完成三条路径直接建 Delivery。目标统一为子成果持久入队，由本体接回继续整体工作；子成果不直接交付或当成用户历史学习。

方案：Task 兼容增加工作/委派角色及父、根工作身份；Attempt 持久记录开始和实际呈现的要求版本，成果固定记录产生版本。新增 work_events 持久收件表，事件用子任务/Attempt/类型生成稳定身份，完成结算与事件入队同一事务。状态区分待处理、处理中、已消费、受阻和未知，并记录 Session 注入及完成回执。

用户输入和后台续接共用会话串行调度，用户输入优先；父工作等待孩子时释放执行槽及孩子需要的资源，避免父子互等。实际仍运行的外部进程继续计入并发与资源占用。父要求变更由本体检查相关子任务，不把补充文字机械追加给所有孩子。

SQLite 与 Pi JSONL 没有共同事务，不能笼统保证模型及工具恰好执行一次。将事件身份、会话回执和动作派发账本关联，重启先核对；能够确认的阶段继续，未知副作用暂停。所有完成入口重新读取取消状态与最新要求。父取消先持久标记后代，再终止实际进程；迟到结果留审计但不复活工作。

必要验证：研究/编码子成果回本体后继续父目标；用户插话与后台结果不并发打开 Session；结果入库、注入、动作派发和消费提交之间的崩溃；父子停止及迟到结果；旧要求成果复用但不自动完成；等待子任务不占槽锁。保留已有 unknown Delivery 不自动重发机制。

### 旧数据兼容

[store.ts](../src/personal/store.ts) 当前业务记录使用 JSON body，可追加兼容字段；原 Task/Session/Attempt/Plan/Delivery 身份保持。新增独立业务 schema 迁移版本和一致备份，不能借用历史导入标记。

旧已完成工作不生成续接或补发；旧未完成工作先对账，再进入新续接机制。Plan 的 afterTaskId 仍代表整体工作完成。保留 [migration.ts](../src/personal/migration.ts) 已有历史导入、源摘要和遗忘保护；不重新导入记忆。迁移需验证重复启动幂等、原文和身份保留、计划依赖及 unknown Delivery 保留。

自动召回仅在用户输入时触发，工具续步与重启复用对应记录，后台结果不触发新自动召回；主动搜索单独存在。已确认送达的本体回复按原有规则学习，子报告不冒充用户发言。工作约定独立保存，默认当前项目或工作，不从记忆推断偏好档案。

## 实现顺序

1. 加入兼容数据字段、schema 版本和持久工作事件，完成迁移与恢复回归。
2. 拆分工具执行目录与模型暴露，实现原生搜索 provider 适配及协议验证。
3. 本体直接文件操作/受授权命令、显式发送和工作控制；执行权限检查共用接口。
4. 接入本地帮手与 herdr 编码委派，统一结果续接、补充要求、取消和预算；按工作类型检查成果。
5. 用户输入自动召回、持久召回记录和子任务相关背景传递；工作约定管理按需发现。
6. 接入满足权限要求的沙箱候选后端，完成恢复故障注入和端到端场景验证。

数据、provider 与主会话接口互相依赖，分步验证；不同时维护第二套任务真相。每一步均先在 development 验证、提交与推送，整体合并仍由用户明确决定。

## 本次实际验证

执行 node --import tsx --test，覆盖 personal-host、personal-herdr、personal-migration、personal-channel、personal-session 五个测试文件：38 项通过、0 项失败。它们验证当前实现基线，不证明尚未实现的父子续接或原生搜索已经可用。未运行全部测试、真实 Telegram 或模型 API。

本次没有修改运行时代码、保存的沙箱配置或个人数据库。沙箱探测只写入独立无敏感内容的目录。实现时更新 CONTEXT、README、操作文档及 ADR 的实际状态，历史证据保留并注明基准。
