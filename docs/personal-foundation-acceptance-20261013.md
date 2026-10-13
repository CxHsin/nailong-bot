# #189 Personal Agent 底座验收：2026-10-13

需求见[规格 #189](https://github.com/CxHsin/nailong-bot/issues/189)，责任边界见 [ADR-0009](adr/0009-runtime-work-context.md)。实现基于 development 的 `e407f89`，受检内容随本文所在提交保存。历史实验与旧验收保持原样。

主要验收链路是 Channel → Host → 真实 Pi 适配层 → 本地模拟 Provider → 文件、持久状态和回复。Provider 控制模型动作与时序，没有执行付费模型请求。

所有写入停止后，最终稳定内容运行 `npm test`：**256/256 通过**，零失败、取消或跳过；`npm run typecheck`、`npm run build`、`npm run docs:check`（60 文档、157 本地链接）及暂存差异检查通过。完整测试日志为 `C:/Users/Cx/AppData/Local/Temp/nailong-189-final-full.log`。评审修复的扩展定向 80/80、入口及约定回归 51/51 通过；撤销两项评审修复时对应测试 2/2 失败，恢复后通过。最终 Spec 复核零剩余发现。

| 保证 | 当前证据 |
| --- | --- |
| 模型无需填写内部要求版本；重复查询不占变更槽且保持访问边界 | personal-foundation-state、personal-direct、personal-orchestration |
| 工具运行时保存显式补充要求，下一请求呈现；旧意图不能完成新要求，已有文件保留 | personal-foundation-state 的运行中工具与完成落账竞争；personal-foundation-channel 的 Telegram `/steer` |
| 同一 control 输入并发重试只产生一个要求更新和 Delivery；普通关联回复仍由模型处理 | personal-foundation-state 的重复输入；原 orchestration 回归 |
| 提示、项目指令、文件、Shell 和默认帮手使用实际工作目录；恢复保留目录与模式 | personal-foundation-workspace、personal-project-context、tool-surface-experiment |
| 本地默认 full access 无逐次权限提案；restricted 与其他入口不自动升级 | personal-foundation-workspace、personal-backends；实验零权限帮手不得写入 |
| 错误直接反馈模型，解释无需读取受阻成果；普通回复不自动完成 Task | personal-foundation-state；成功完成仍检查材料、未知效果和孩子状态 |
| 保存未呈现、已呈现未完成两种要求边界在真实进程死亡后可恢复，不重复派发 | personal-foundation-state 的两项 SIGKILL；personal-restart-boundaries 的未知外部效果与取消回归 |
| 实验共享权限与派发路径，快慢帮手真实接回，四维评分可分别失败，首次请求前冻结 | tool-surface-experiment 29 项；本地 workflow 夹具两组通过；discovery 仅导出计划 |

SIGKILL 两项分别观察持久要求与呈现回执，不声称中断恰好发生在 completion marker 与 Host transaction 之间；该边界沿用现有真实 Pi 回执修复的异常注入测试。

反事实证据包括：移除要求注入后 Provider 断言缺失新要求；非成功结算读取不可用目标时失败；未统一工作目录时实际文件缺失；trusted 删除仍走提案时文件未删；帮手直接写文件时缺少派发账本；撤掉 Telegram 接线时要求未即时保存。恢复相应修复后定向用例通过。

双轴评审基准为 `e407f89`。Standards 无硬性违规，首个状态测试的重复基础设施已统一使用夹具。Spec 发现非交互入口继承本地 trusted、Skill 读取冒充帮手复查两项，修复同时核对实验实际模式与冻结模式一致。首轮全量发现 HTTP 重试要求消息重复追加导致预算计数归一，修复后保留原 `[1,2]` 请求计数断言；迁移和命令夹具更新到准备工作身份的上下文，非成功续接保留已有帮手材料。

第二轮全量发现初始工作要求先于原生搜索恢复注入，非空 Session 使检查点恢复被跳过。将初始注入移到原生恢复之后，保留搜索记录唯一性断言；真实进程死亡测试 1/1、原生与状态组合回归 31/31 通过。

Pi Durable、真实付费端点对照、生产部署与 main 合并均未执行。本轮不据此判断工具接口优劣；interface、workflow、discovery 分开控制，旧 passed 不追改。
