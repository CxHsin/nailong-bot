> 2026-10-14 历史记录：本文的旧 Host/Task、权限与结算、记忆或实验行为已从在线入口退役。当前行为见 [ADR-0010](../../../docs/adr/0010-native-pi-assistant.md)；当时证据保留，不能作为新版保证。源码基准为 727a294293463332e55558fa3e5ba518719d6890。

# 校准后的工具接口实验

对应 [#193](https://github.com/CxHsin/nailong-bot/issues/193)，规格为 [#189](https://github.com/CxHsin/nailong-bot/issues/189)。批次标识 `foundation-20261013-v2`。本入口只操作临时合成材料，不启用生产接口迁移。

[旧真实模型报告](../../../docs/research/personal-agent-tool-live-2026-10-13.md)及其原始 JSON 保持原来的 `passed`。旧批次同时改变权限提案方式、提示和工具形状，帮手直接写文件；它们是历史记录，不能与本批次合并计算或证明接口形状的因果效果。

## 相同底座

每次运行建立独立的临时项目、历史、Host SQLite 和真实 Pi Session。本地 Responses Provider 控制工具调用与时序；链路为 Plain Channel → Host → Pi → Provider → 文件、持久事实与回复。工具定义仍经过真实协议传输。夹具证明机制，不衡量模型质量。

两组初始材料、工作目录、同步查询、完成语义、权限与审批策略、执行实现及预算相同。工作目录是临时 `project`，内部 Session 目录只存记录；默认帮手继承工作目录。两组都由实际文件操作推导精确路径提案，批准/拒绝来自独立脚本人类输入。审批只接受项目及具体合成目标文件，删除原件始终拒绝。

默认 `organize`、`memory`、`delegation`、`stale` 使用 full access (`trusted`)；`approval`、`denial` 单列为 `restricted`。full access 使用真实 Host 授权语义；实验额外把操作限定为合成材料，避免远程试验触碰项目。该限定不是生产 full access 的沙箱承诺。每个夹具先重复同步查询，再继续执行与结算；模型不填写内部要求版本。

帮手通过 `createWorkTools` 的权限检查和 Host 派发账本写入，零权限不能生成文件。快速帮手可直接接回正确材料；延迟帮手等待初始 Channel 回复完成的确定性屏障，再实际写入并后台续接。评分检查文件读取、真实材料、子完成与整体完成，不以事件是否 consumed 单独判败。

`interface.ts` 的 bash 是进程内有界适配器，仅支持 `mkdir`、`mv`、`rm` 和 `agentctl`，调用原工具；未启动系统 Shell、独立 CLI 进程或 herdr。

## 单因素入口

默认 `--factor interface` 比较独立工具 A 与 CLI D，两组采用 inline 指导，D 不同时加载工作流 Skill。D 通过 `agentctl work --help` / `agentctl memory --help` 取得参数；工作与历史操作映射同一批生产工具。目录/移动/删除的终端拼写属于接口形状变化。A/D 均使用相同精确系统提案，不能把权限策略差异算成工具数量效应。

`--factor workflow` 固定 CLI 形状，只比较 inline 与读取工作流 Skill。每次重复交替两组顺序，不共享 Session 或材料。发现方式的后续对照见下面的计划入口；三个变量分开试验。

```powershell
npm run experiment:tools -- --scenario organize --factor interface
npm run experiment:tools -- --scenario memory --source injected --factor workflow
npm run experiment:tools -- --scenario memory --source retrieved
npm run experiment:tools -- --scenario delegation --helper delayed
npm run experiment:tools -- --scenario delegation --helper zero-permission
npm run experiment:tools -- --scenario organize --permission restricted
node --import tsx --test test/tool-surface-experiment.test.ts
```

`--source` 只用于 memory；已注入和未注入原话分别运行。即使来源已注入，明确要求主动搜索/读取仍按指令维度检查。`--helper` 只用于 delegation；零权限场景使用 restricted，并验证权限拒绝后的普通回复。权限模式不能把 approval/denial 改成 trusted。默认入口只跑六个场景的 A/D 对照，不自动展开所有组合。

### 后续按需发现对照

使用计划入口输出冻结计划：

```powershell
npm run experiment:tools -- --factor discovery --plan --output C:/Users/Cx/AppData/Local/Temp/nailong-discovery-plan.json
```

计划固定独立工具语义、inline 指导及同一场景，只比较常驻工具与 Provider 原生按需发现。先接通并核验真实 wire 请求的发现配置，再单独授权 live；当前入口仅导出计划，不执行这个尚未接通的对照。

## 冻结与评分

运行前先持久保存 `complete: false` 报告，包含 `frozen.input`、初始材料、评分键、Pi/Host 预算、权限/帮手/来源/指导模式及输入和策略 SHA-256。实际调用开始后，每完成一个任务更新报告；全部结束才置 `complete: true`。新批次使用独立输出文件。中断批次不作为完整成功率分母。

| 维度 | 观测 |
| --- | --- |
| `artifacts` | 真实文件内容、归档位置、原件保留或确实未生成越权文件。 |
| `instructions` | 明确要求的搜索、读取原话、实际读取帮手材料。 |
| `permissions` | 精确审批/拒绝、无未知派发、帮手文件效果有实际派发记录。 |
| `lifecycle` | 显式整项完成、子完成；拒绝及零权限保持未完成；新要求阻止旧结论结算。 |

`passed` 是本批次全部维度和场景检查的合取；拒绝场景正确未完成可以通过。正确材料但漏搜索只让指令维度失败；正确材料及搜索但漏结算让生命周期失败。不要用单一完成率解释这些不同失误。

`stale` 通过公开 Host 要求更新入口，在模型提交完成意图后、Host 落账前添加新要求。已有文件保留，旧意图不能完成新目标，后台模型请求可正常解释。它不是测试模型猜内部版本号，且只用于离线回归。

报告的 `root` 保存实际材料、Session 和持久状态供复核；`trace` 保存工具成功/错误，CLI 内部操作与 bash 可能同时记录，不能相加当独立失败次数。`wireTools` / `wireToolBytes` 仅在本地夹具记录真实请求；live 为空。`surfaces` 是 UTF-8 schema / 指令字节，不是首请求 token。

## Live 与预算

默认不加载 `.env` 或远程模型。live 必须显式 `--live --model ALIAS`，沿用现有 `MODEL_*` 配置与 native tool-search 能力检查。本次实现不运行付费试验。

离线 Pi：5 秒、20 请求、60,000 token；Host：根 24 / 全局 30 调用、100,000 token、120 秒。live Pi：360 秒、20 请求、200,000 token；Host：根 24 / 全局 30 调用、300,000 token、360 秒；不重试。live 请求开始至少间隔 15 秒，等待单列 `pacingMs`，不能保证消除 429。

`usage.cost` 为 null，端点占位零价不是实际零费用。token 包含缓存用量且不能请求中途截断。夹具固定模拟用量与耗时不用于性能比较。主模型即使改为 live，审批与帮手仍是合成实现；结论只适用于所测任务及因素。
