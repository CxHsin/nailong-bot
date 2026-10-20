# 奶龙互动、全局路由与启动招呼验收

规格 [#260](https://github.com/CxHsin/nailong-bot/issues/260)，实施任务 [#261](https://github.com/CxHsin/nailong-bot/issues/261)、[#262](https://github.com/CxHsin/nailong-bot/issues/262)、[#263](https://github.com/CxHsin/nailong-bot/issues/263)、[#264](https://github.com/CxHsin/nailong-bot/issues/264)。2026-10-19 开始实现，2026-10-20 集成验证；基准 `29290cc1d065eb8bf978aedf974e195e0662204f`，集成分支 `development`。

## 验收入口与行为证据

按规格已确认的 Telegram + Assistant Service 组合接缝，使用临时持久目录、localhost Magpie/模型响应与受控 Telegram API。饱食度只注入局部时钟；启动测试走生产 `createTelegramService`，复用真实初始化和关闭过程。

| 保证 | 行为用例入口 |
| --- | --- |
| 首页缓存直达、返回首页、饱食与投喂、四档及草稿独立保存、全局模型能力与作用范围 | `test/assistant-persona-panel.test.ts`、`test/assistant-control-panel.test.ts` |
| 饱食度 24/48 小时、三档边界、反复读、回退、离线重启、reset、会话隔离和动作重放 | `test/assistant-persona.test.ts` |
| 当前输入身份、明确投喂/收录、原生贴纸包、素材去重、安静档、错误目标、拒绝/限流/未知发送保留正式回复 | `test/assistant-persona.test.ts` |
| 真实处理提示、正文接替且共用草稿、草稿关闭与发送失败 | `test/assistant-waiting-preview.test.ts`、`test/assistant-control-panel.test.ts` |
| 两模型在途/待判断切换、跨会话及重启、主模型隔离、空闲直通与持久决定复用 | `test/assistant-routing-magpie.test.ts` |
| 无选择、断连、模型移除、预算、无效内容、错误与超时保留原文/附件，旧配置不阻断初始化 | `test/assistant-routing-magpie.test.ts`、`test/assistant-cli.test.ts` |
| 启动一次生成、无模型/空/错误/超时、并发切换、关闭取消、辅助 usage、发送回执及工作隔离 | `test/assistant-startup.test.ts` |

RED → GREEN 实际观察：缺失控制字段和工具、未接收贴纸输入、饱食阈值浮点边界、旧频率动作重放、贴纸包名称、合法回应类型、缺失启动生命周期入口、关闭后等待已关闭 Harness，以及启动消息提前停止普通草稿。等待提示用例先因无预览失败；修复空消息结束事件和空正文覆盖后，同一草稿可由真实正文接替。

## 集成检查与评审

三个实现工作区在集成前分别停止全部源码和测试写入；merger 集成后也明确停写，再由集成负责人运行综合检查。首个实现提交 `cb30ce0` 在 `development`，没有推送。`npm run typecheck`、`npm run build`、`git diff --cached --check` 通过；`npm run docs:check` 检查 110 份 Markdown、478 个本地链接通过。

首次完整测试 269 项，268 通过、1 失败；唯一失败为新增预览网络故障用例匹配了原始错误，而 grammY 对外返回包装后的 `HttpError`。修正到实际边界错误后，该文件 3/3 通过；源码未因此修改。

评审基准为 `29290cc...cb30ce0`，规范轴与规格轴由两个只读代理独立执行。规范轴发现 2 项：`routingStatus` 仍读取已退役配置、ADR-0013 缺少模型来源被替代的说明。规格轴通过受控组合夹具复现 3 项：进行中 Work Supplement 的身份未纳入互动校验、装饰性互动停止普通正文草稿、主模型输入缺少被回复消息的真实目标。五项由同一实现代理修复；同路径检查也补齐了 queued supplement 的运行材料。

修复后的行为证据：`assistant-persona.test.ts` 拒绝被引用消息的投喂授权，允许用户明确指定的真实回复目标 reaction；当前工作补充可以投喂，暂停、重启、恢复后同一动作返回 `accepted:false`，新批次不能复用旧补充身份。`assistant-waiting-preview.test.ts` 先因装饰回应后正文预览超时失败，修复后验证正文沿用同一草稿并正式送达。`assistant-routing-magpie.test.ts` 验证状态同步显示 A/B 选择并跨重启保留；`assistant-routing.test.ts` 验证 queued supplement 的回复目标、引用正文和素材身份进入模型，旧 fixture 显式别名仍有效。上述代码缺口均实际观察到修复前失败、修复后通过；ADR-0013 已补带日期的替代说明及当前入口链接。

修复代理完成后停止全部源码、测试和文档写入。其定向验证 7 个测试文件共 49/49 通过，修正两处 Grammy 夹具类型后，受影响用例另跑 2/2 通过；类型检查和差异空白检查通过。集成负责人随后在源码和夹具保持稳定的前提下运行最终检查，受检内容为 `cb30ce0` 加本记录所在提交的修复。

最终结果：`node --import tsx --test --test-concurrency=4 test/*.test.ts` 共 **272/272 通过**，0 失败、取消或跳过；`npm run typecheck`、`npm run build` 通过；`npm run docs:check` 检查 **110 份 Markdown、480 个本地链接**通过；`git diff --cached --check` 通过。完整测试原始日志保存于本机临时路径 `C:\Users\Cx\AppData\Local\Temp\nailong-implement-260\final-full-test.log`。Issue 保持开放，待获准推送后通过 PR 合并关闭。

## 真实接入范围

本次没有启动或重启生产 Bot，没有发送真实 Telegram 消息，没有调用真实 Magpie 生成，也没有安装或更改生产配置。上述自动化不代表手机回显、真实素材或真实模型自然度已验收。

待真实部署授权后核对：主模型上线招呼、路由实际命中新选择、收录真实贴纸与消息回应、四档表达与投喂、首页缓存导航。模型成功与 Telegram 送达分别核对 `startup-tests.jsonl`、auxiliary `requests.jsonl` 和 `telegram-sends.jsonl`；未知 usage 不记零，未知发送不自动重发。
