# #167 当前实现与验收：2026-10-13

本文保留 #167/#173 当时验收矩阵和固定执行器基线，不代表当前编码入口。#177 项目 skill 的现行闭环证据见[最新验收](personal-herdr-skill-acceptance-20261013.md)。固定执行器代码与测试以 [3a7760b](https://github.com/CxHsin/nailong-bot/tree/3a7760bea6c7d85e233c3f0eae3eb592b144a958) 为历史基准。

实施分支 development；#173 受检基础提交 `dcc8152`，其上包含本文所列实现，受检内容随本文件所在提交保存。本文记录实际已跑证据，不表示已合并、部署或完成真实端点矩阵。需求及六项责任见 [规格 #167](https://github.com/CxHsin/nailong-bot/issues/167)；架构见 [ADR-0008](adr/0008-personal-agent-orchestration-direction.md)。

集成负责人收齐全部写入者 STOPPED 后，对稳定暂存内容运行 `npm test`：196/196 通过，零失败、取消或跳过；`npm run typecheck`、`npm run build`、`npm run docs:check`（49文档/95链接）和 `git diff --cached --check` 通过。完整日志 `C:/Users/Cx/AppData/Local/Temp/nailong-173-parent-full-final.log`。首次全套检查发现旧 CLI 崩溃夹具指定未授权目录并仍假设整体身份是实际执行身份，导致超时；改用默认授权目录、核对持久帮手身份后 CLI 4/4 及全套通过，未放宽生产权限。

最终双轴审查在 `50a4e95` 发现 Spec 两项：根工作自身或后代未知动作仍可能宣布完成；同调用身份改内容可能复用旧成功证据。修复后统一完成事务保留 partial/等待与取消事实，不产生完成 Delivery；成功重放核对规范化内容和要求版本，委派保存可核对身份，旧缺身份记录保守拒绝。正常原文背景重放排除主机生成的时间戳，保留实际来源与要求版本。Standards 未发现硬性违规；其重复后端匹配逻辑建议已由共享匹配函数落实。受影响 69/69 通过；再次收齐 STOPPED 后，最终稳定暂存内容全套 **207/207** 通过，类型、构建、49文档/95链接及暂存差异检查通过。最终完整日志 `C:/Users/Cx/AppData/Local/Temp/nailong-167-final-full.log`；测试修复和本文同提交保存。

## 四场景与公共验证

| 场景 | 当前证据 | 边界 |
| --- | --- | --- |
| 本体直接行动、按需发现 | personal-direct 实际文件/受控移动/删除确认/owner Delivery；native-tool-search 协议/当前定义/压缩后重新发现；personal-retrieval 的 Responses search→fetch 实际回执 | 普通端点不曝光网页、计划、约定专用 schema；发现不授权。真实模型纯工具证据见下方 |
| 帮手回传、本体续接、插话/补充/停止 | personal-orchestration 的真实 Pi HTTP、herdr CLI 夹具、实际 Node 验收命令、相关帮手改向和资源；personal-retrieval 的 narrowed restricted/network grant→子检索→本体核验回执→整体完成，子 Delivery=0 | 编码外部 Agent 为受控边界夹具；本轮真实 herdr/Telegram 未复验 |
| 仅用户输入召回、当前表达与明确约定 | personal-memory-context 的实际 HTTP/Pi/SQLite、召回去重/呈现出处/遗忘/working agreements、孩子 request_context/provide_context 与嵌入全局预算 | 约定只接受用户后续明确确认；孩子不获得全部历史工具。嵌入端点为本地夹具 |
| 重启对账、未知暂停、预算达限 | personal-restart-boundaries 的3个实际 SIGKILL 子进程、PersonalHost/SQLite 与 fsync effect；personal-orchestration 的 Session 回执/预算/取消；personal-memory-context 的真实嵌入请求死亡 | SIGKILL 的 Dialogue/Executor 是受控系统边界 fixture，不能称为真实模型 Session/Telegram 杀进程验收；throw故障测试单独作为补充 |

`node --import tsx --test test/personal-backends.test.ts test/personal-direct.test.ts test/personal-herdr.test.ts test/personal-orchestration.test.ts test/personal-retrieval.test.ts test/personal-restart-boundaries.test.ts test/personal-memory-context.test.ts test/native-tool-search.test.ts test/native-tool-search-failures.test.ts test/tinyfish.test.ts`：78/78 通过。原始日志 `C:/Users/Cx/AppData/Local/Temp/nailong-173-focused.log`。其中3个 SIGKILL 验证：结算材料唯一续接、executor不重跑/最终 Delivery一次；effect落盘而回执未结算后不重做且未知占用保留；本体背景响应已结算、孩子尚未确认时重启复用定向 packet，不再请求本体响应。

修复红例包括：目录内硬链接实际读出范围外原文；verified但异范围的命令/herdr后端实际派发；异步后端检查间隙缩小权限仍沿用旧范围；无效 URL 来源被过滤后有效 artifact 让 generic 工作通过；普通端点常驻网页与计划 schema。对应修复后断言实际拒绝、零派发或 partial，保留源哨兵和 invalidMaterials。

补充计划发现正例：`node --import tsx --test test/personal-retrieval.test.ts test/personal-plans.test.ts`：9/9 通过（日志 `C:/Users/Cx/AppData/Local/Temp/nailong-173-plan-regression.log`）。production Runtime 的 Responses 夹具实际 search→tool_search_output→plan_control，Host 持久化明确目标、时间、时区、错过规则及 owner/conversation；计划 schema 始终不进入常驻前缀。此新增用例不计入上面的旧78条结果。

## Windows 候选后端实测

实测 UTC `2026-10-12T17:56:57Z`（Asia/Shanghai 2026-10-13）。Windows 24H2 `26100.4652`，Codex `0.162.0-alpha.17.2`；二进制 SHA256 `d13914ced6c7af174d8d638db938284231227312104b06a25e9608c632a7daec`。全程明确 `windows.sandbox="unelevated"`，未安装后端、提升管理员权限或启用 MXC。

| 实际控制 | 结果 | 能建立的保证 |
| --- | --- | --- |
| strict descriptor：root deny/minimal read/显式 write | 子命令创建前报需要 elevated backend | 完整读取隔离不可用 |
| workspace-write 范围内读写、范围外读取 | 内部成功，外部读取成功 | readIsolation=false |
| 外部直接写、junction/hardlink写别名 | 外部写拒绝，父进程确认文件未生成/哨兵未改变 | 仅采样显式目录的部分写边界 |
| network_access=false，连接父进程127.0.0.1监听器 | 实际TCP连接被接受1次 | networkIsolation=false |
| 前台正常exit0，detached孩子 | PID/创建时间对应且heartbeat继续 | generic processTreeStop=false |
| 1200ms超时后wrapper taskkill /T /F | 采样拓扑孩子PID消失、heartbeat停止 | 只证明该活跃拓扑，不推广到任意脱离/重挂父进程 |

原始证据目录 `C:/Users/Cx/AppData/Local/Temp/nailong-173-real-probes-63834efb9b5541b1b5159ce0870bd644` 内的 report.json、notes.md、probe.mjs、process-probes.mjs。测试进程、监听器及临时 alias/文件均已清理；没有操作生产 bot。

execution-backends.ts 可从明确配置登记 version1 采样 evidence，检查物理 executable/hash、OS release、policy digest、7天有效期及准确根目录；OS release 不含注册表 UBR，不宣称完整 patch-build 匹配。当前适配器固定缺失读/网络/通用树停止，仅输出 partial 诊断；supports 和 execute 均拒绝受限命令，即使配置把 capability 布尔值翻成 true。**当前没有通用可执行 Codex sandbox adapter**；完整受限执行仍需独立实测与新增适配器。默认受限 Shell/独立检查/herdr 缺后端时零派发，不自动改成可信执行。受控文件和明确网络授权下的检索仍可使用。

## 来源与权限

Tinyfish 单 URL 抓取保存实际 provider-returned content，不捏造最终 response URL、HTTP 状态或新鲜度证明。回执关联成功 ActionDispatch、adapter版本、URL、摘要和 owner/root；submit_material、complete_work、inspectMaterial 使用同一受信账本核对。原文摘录/URL/身份失配和伪造回执保持 partial，不能被其他有效文件掩盖。生成文件仅是 local material，不能当作远端检索事实。

后端选择及派发核对最新授权；异步 supports 期间 grant/cwd/revision 改变不会使用旧权限。herdr 对目标/模式变化也拒绝沿用旧 exact action。独立检查保持结构化 command/args，不拼接 Shell。孩子 scope 只能缩小父 roots/network/mode/expiry/语义授权；默认无网络、无可信 Shell、无删除/外发权限。read/write 均保守拒绝 nlink>1 普通文件。

## 真实端点与历史证据

2026-10-13 原 #169 适配器已在配置代理 `gpt-6.1-sol` / Responses 实际完成 Host→search→probe_sum(2,3)→5，3次HTTP、工具1次。见[原生搜索记录](native-tool-search.md)。本轮没有重复外部端点探测。真实 Anthropic 当前不可用，只有协议夹具；统一流程的真实研究/编码本体续接仍未由真实模型端点全矩阵验证。

[2026-10-12 herdr](personal-herdr-acceptance-20261012.md) 与 [Telegram](personal-telegram-acceptance-20261012.md) 保留原日期、提交和消息455/456/457/470等证据，它们是 #157 基线，不替代 #167 新流程验收。本轮真实 Telegram 的自然语言接单、运行中插话/改向/停止、重启及计划完整矩阵仍未执行。没有部署、PR、main合并或新增外发授权。
