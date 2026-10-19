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

## 真实接入范围

本次没有启动或重启生产 Bot，没有发送真实 Telegram 消息，没有调用真实 Magpie 生成，也没有安装或更改生产配置。上述自动化不代表手机回显、真实素材或真实模型自然度已验收。

待真实部署授权后核对：主模型上线招呼、路由实际命中新选择、收录真实贴纸与消息回应、四档表达与投喂、首页缓存导航。模型成功与 Telegram 送达分别核对 `startup-tests.jsonl`、auxiliary `requests.jsonl` 和 `telegram-sends.jsonl`；未知 usage 不记零，未知发送不自动重发。
