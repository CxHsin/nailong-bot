# 隔离工具接口实验

对应 [Issue #186](https://github.com/CxHsin/nailong-bot/issues/186)。研究背景见[调研笔记](../../../docs/research/personal-agent-tool-surface-2026-10-13.md)。验证问题：在相同合成任务和 Host 保证下，独立工具与「基础工具 + skill/CLI，系统处理权限」哪种接口更适合模型完成工作？正式入口没有启用实验适配器。

[2026-10-13 真实模型结果](../../../docs/research/personal-agent-tool-live-2026-10-13.md)：gpt-5.6-luna 的 20 次配对任务已跑完，逐场景报告严格流程及补充目标成果两种口径，并保留原始 JSON。

## 两组接口

| 组别 | 首次本地 Responses 请求 | 工作方式 |
| --- | --- | --- |
| `independent`（A） | 13 个工具，包括发现入口 | 文件操作、权限提案、记忆、工作控制、委派和结算使用现有独立工具。 |
| `skill_cli`（D） | `read`、`write`、`edit`、`bash`、`tool_search`，共 5 个 | 正文仍用文件工具；目录/移动/删除使用终端；记忆与工作操作通过 `agentctl` 的按需帮助；权限由具体文件操作触发系统提案。 |

这是完整接口方案的比较，包含技能提示、帮助往返和系统提案方式的差异。不能把收益归因于工具数量这一单独因素。A 也使用有界终端；它是独立接口基线，不是任意 Shell 的生产执行基线。

[interface.ts](interface.ts) 的 `bash` 是进程内命令适配器，只接受 `mkdir`、`mv`、`rm` 和列出的 `agentctl` 命令。它调用原工具，保留 Host 授权、动作账本和成果验收，**没有启动系统 Shell、独立 CLI 进程或 herdr**。本轮检验模型看到的入口组织方式，尚不检验操作系统沙箱或任意脚本执行。

D 使用[实验技能](skill/SKILL.md)；模型先读技能，再按需请求帮助和参数定义。CLI 不能授予权限。系统从文件操作推导路径，以独立的脚本人类输入调用 Host 审批；只有预定合成范围可以批准，删除原件始终拒绝。权限提案和审批仍是两步。

审批策略只同意当前工作目录及目标合成文件，申请整个 `protected` 目录会被拒绝。Windows 路径比较遵循 Host 的大小写归一化；脚本审批后的批准/拒绝状态会明确返回给模型，两组都能观察结果。离线授权回归包含先读后写，以覆盖 Host 归一化之后的再次权限扩展。

## 默认离线核验

```powershell
npm run experiment:tools
node --import tsx --test test/tool-surface-experiment.test.ts
```

默认不加载 `.env`、不调用远程模型。每次任务创建独立临时目录、合成文件与历史、SQLite 状态、真实 Pi Session 和真实 PersonalHost。输出 JSON 的位置在终端显示；合成材料、Session 与状态保留在各次报告的 `root`，可复核实际执行。

每完成一个任务即保存报告；`complete: false` 表示批次尚未跑完，正常结束后置为 `true`。中止的批次保留已完成任务，不能直接按完整试验计算成功率。

本地 Responses SSE 服务预定模型的工具调用；帮手是确定性的合成执行器。它们证明调用链和控制边界，不能测量模型自主选择工具、编写命令或委派外部 agent 的质量。

| 场景 | 验收事实 |
| --- | --- |
| `organize` | 原文件移入归档目录，原文保留、原路径消失，Host 完成工作。 |
| `approval` | 经独立审批后写入受限合成文件，Host 完成工作。 |
| `denial` | 用户拒绝扩展授权，原文件不变、工作未完成。 |
| `memory` | 实际搜索及读取历史原消息，输出正确出行原话与角色，Host 完成工作。 |
| `delegation` | 实际读取帮手文件，子工作完成、结果事件消费，整体工作完成。 |
| `stale` | 夹具故意提交版本 0，当前版本 1；原结算工具拒绝、Host 未完成。仅用于离线失败回归。 |

默认共 6 场景 × 2 接口 = 12 次任务；测试另外核验不支持的命令、越界路径、自行授权和删除拒绝，合计 20 个测试。越界核验使用外部合成哨兵文件，并检查无权限提案、无动作派发；不会操作项目文件。

## 真实模型 pilot

真实模型必须显式选择 `--live --model ALIAS`。配置使用当前仓库的 `MODEL_*` 环境变量，要求模型及端点支持原生 Responses 或 Anthropic 工具发现。模型能力检查沿用 `nativeToolSearch`，不会自动把兼容端点认作支持原生发现。

例如已在 `.env` 中配置别名 `gpt` 时，先跑一个场景的两组配对：

```powershell
node --env-file=.env --import tsx scripts/experiments/tool-surface/run.ts --live --model gpt --scenario organize
```

通过后可对五个正常场景各做两次配对：

```powershell
node --env-file=.env --import tsx scripts/experiments/tool-surface/run.ts --live --model gpt --scenario all --repeat 2
```

后者共 20 次远程模型任务；`stale` 不参与 live。重复次数为 1–10，重复间交替两组顺序。两组没有共享 Session、材料或授权状态。Live 使用 Pi 每 Session 20 次请求、200,000 token 上限，整个模型循环与单次远程请求超时均为 360 秒、不重试；Host 根工作 24 次/全局 30 次调用、全局 300,000 token，执行与续接时间预算 360 秒。token 预算包含重复请求的缓存 token，由返回的用量累计，不能在请求中途截断超限输出；这些限制也不是整个 pilot 的费用或总耗时上限。离线夹具继续使用原 5 秒/60,000 token 预算。

2026-10-13 真实预检暴露了原 60 秒整个循环及 60,000 token 上限过紧，以及端点 HTTP 429；首次校准采用 180 秒，CLI 归档在 177 秒通过。完整试验两组统一使用上述 360 秒预算，为节流后的 20 次请求留足时间。Live 请求开始时间至少间隔 15 秒，跨接口和场景共享节流状态，报告单列人为等待 `pacingMs`。预算及节流校准前的记录、180 秒 pilot 与完整试验单独报告，不合并计算成功率。节流只能降低请求频率，不能保证端点不再返回 429。

仅为当前测试进程选择 `gpt-5.6-luna`、显式验证兼容端点的原生协议时，可在 PowerShell 使用：

```powershell
$env:MODEL_GPT_MODEL = 'gpt-5.6-luna'
$env:MODEL_GPT_TOOL_SEARCH = 'native'
node --env-file=.env --import tsx scripts/experiments/tool-surface/run.ts --live --model gpt --scenario organize
```

这些进程环境值优先于 `.env`；测试结束后在同一 PowerShell 中清除临时覆盖，或使用独立终端进程。正式配置文件不需要修改。

Live 的主对话由真实模型生成；人类审批及帮手仍是上述合成实现。因此它能回答这五种任务的主模型接口选择问题，不能回答真实外部帮手、开放网络任务或任意 CLI 的总体可靠性。初次搭建（`f0d3c50`）未执行远程模型请求；后续真实结果单独记录。

## 如何读报告

- `checks`/`passed`：文件和 Host 持久状态验收，拒绝场景允许正确的未完成结果；失败退出码为 1。历史答案检查完整原话及 `user`/「用户」角色词，允许角色与原话分行；不是要求固定的 `user：原话` 排版。
- `requests`/`usage`/`elapsedMs`：整个任务的原生请求次数、提供商返回的 input/output/cache token、端到端时间。`limits` 记录实际 Pi 预算；`pacingMs` 单列人为等待，`elapsedMs - pacingMs` 仍包含工具、Host 和网络时间，不能称为纯推理耗时。夹具 token 是固定模拟值，耗时与调用数不能用于模型性能比较。
- `usage.cost`：`null`。当前自定义模型配置的价格是零占位值，不能据此报告零费用；实际费用需结合端点账单或核验过的价格。
- `surfaces`：适配后的全部工具定义与基础指令 UTF-8 字节数，包括尚未加载的专用工具；不含发现入口、追加技能目录、项目上下文及提供商转换，不能当成首请求 token。
- `wireTools`/`wireToolBytes`：只有本地夹具能捕获真实 Responses 请求的工具名和 JSON 字节。Live 为空；尤其 Anthropic 的 deferred 传输目录不能按本地 Responses 的 13/5 直接计数。
- `trace`：终端及内部操作的成功/错误事件。一次 CLI 错误可能同时记录内部操作和 `bash` 错误，不能直接相加当作独立错误次数。报告不保存命令参数或 API Key；完整原始动作可在临时 Host 状态与 Session 中核验。

先逐场景查看配对成功/失败和实际失误，再比较成功任务的全部用量及时间。关注技能是否被读取、帮助是否被理解、参数是否有效、是否漏结算。小样本用于发现退化并决定下一轮，不能证明最优工具数量；权限或成果保证退化时不能据 token 收益迁移。

本轮范围不含生产迁移、计划/取消/重启完整生命周期、浏览器或外部研究。原 13/5/3 暴露实验保留为研究历史；当前入口对照是 A/D，后续根据真实模型结果决定是否迁移。
