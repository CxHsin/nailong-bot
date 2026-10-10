# Follow-up、Steer 与 Stop 验收

规格 [#136](https://github.com/CxHsin/nailong-bot/issues/136)，实现任务 [#137](https://github.com/CxHsin/nailong-bot/issues/137)。验收日期：2026-10-10；开发分支：development。没有部署或重启生产 Bot。

主要边界为合成 Telegram 更新／真实 CLI 输入 → 生产 Host → 真实 Agent → 本地 HTTP Provider。只替换外部 Telegram API、Provider 和 MCP 服务；模型请求正文、工具副作用、持久事实和 Channel 输出共同证明行为。屏障控制模型步骤与工具批次，不以延时推断执行顺序。

| 规格验收组 | 证据 |
| --- | --- |
| AC01–AC05 | input-controls：A/B/C 独立顺序运行、重复输入去重、完整双工具批次后两条 Steer、无工具步骤续跑、空闲／排队／停止中的回退、图片、多技能及冻结版本；telegram-skills 保留未知／歧义引用反例 |
| AC06–AC09 | input-controls：模型流与工具期间 Stop、旧 Steer 与 /model、/reset 取消、只读诊断、重复 Stop 与新输入、失败取消和 Conversation 隔离；runtime-progress／responses-progress-phase 验证草稿和阶段结算；Akasha 不含从未消费输入 |
| AC10 | input-controls：协议反馈与用户 Steer 交错，过时反馈不进入新请求，不产生第三次模型调用 |
| AC11 | input-controls：技能文件变更、关闭／重开数据目录、损坏派生缓存、真实压缩和重建顺序相等；停止状态在摘要外保留，预算拒绝的引导不复活；continuous-context／cache-provider 保留连续上下文回归 |
| AC12–AC13 | host-process：进程异常退出、一个恢复汇总、不重跑旧队列、不重复成功通知；同目录别名拒绝、两个进程同时争用、不同目录独立、正常／异常退出释放锁。input-controls 补充 Telegram 恢复已知失败重试、未知交付及崩溃通知去重 |
| AC14 | CLI 输入流验收与 Windows 真实终端操作，见下文 |
| AC15 | input-controls：标准／原生 Telegram 投影的引导回执明确拒绝后重试，未知交付不重跑；持久 Run 成功和最终答复不回退；既有交付回归覆盖停止与失败结算 |

真实 Windows 终端以隔离临时数据目录启动 `node --import tsx src/cli/main.ts chat --json`，Provider 使用本地 HTTP SSE：

1. 输入 `hold-task`，Provider 确认请求后保持模型流。
2. 发送真实 Ctrl+C，观察 `stopping`、一个 `run_cancelled`、`stopped` 与取消条数 0。
3. 同一终端输入 `fresh-task`，观察新 Run 成功和 `terminal-complete`，证明读取能力保留。
4. 空闲再次 Ctrl+C，进程以 0 退出。结构化控制事实同时含 phase、receiptId 和 cancelledInputs；自动输入流／子进程测试解析逐行 JSON。

缺陷反例：移除 `effectiveInput` 的未生效引导过滤，`a prepared Steer rejected by the input budget remains audit-only after failure and reconstruction` 实际失败（1 条测试、1 条失败）；恢复修复后通过。压缩后的跨 Run 重建测试在未记录 `retainedInstructionThrough` 时失败，表现为当前用户输入与日期在下一轮消失；记录后请求顺序相等。

完整 `npm test`：416 条通过，0 失败、0 取消。完整运行暴露了两个需随新契约更新的旧断言（菜单和输入错误回执），以及两个全套并行负载下的子进程超时；修正断言和子进程验收上限后通过。随后新增 Run 结束／Steer 校验碰撞的顺序反例，`host.test.ts` 与 `input-controls.test.ts` 共 22 条通过。类型检查和构建通过。后续代码评审修正及其验证见 #137 的实施记录。

模拟验收证明运行与输入契约，不证明远程模型的任务完成质量或服务缓存、成本与延迟。真实 Telegram 客户端排版和生产部署属于单独验收。
