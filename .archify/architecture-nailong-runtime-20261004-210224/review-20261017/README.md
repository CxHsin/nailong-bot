# Codemap 更新与评审

日期：2026-10-17。源码基准：`302532c32d30e47860f376bd051efa236b2191d4`（development，已同步 origin/main）。旧图基准：`5b93ef399a2e92d7a278252f8ff84d1367a185c4`。

## 价值、成本与影响

旧图仍以 Native Pi Session 和 JSONL 会话为主路径，遗漏当前持久队列、Pi Durable、上下文意图路由与共享记忆，还声称旧诊断和历史数据继续保留。导航会把维护者带到错误的执行与状态边界，值得立即更新。

复用现有 Archify 3.0.1、candidate 和 [HTML 地址](../nailong-runtime.html)，更新为 14 个组件、19 条关系，并将 42 个源码引用固定到受检提交。说明依据 [ADR-0011](../../../docs/adr/0011-durable-main-agent-and-conversation-queue.md)、[ADR-0012](../../../docs/adr/0012-layered-memory-and-stable-context.md)、[ADR-0013](../../../docs/adr/0013-contextual-input-routing.md)和 [ADR-0014](../../../docs/adr/0014-retire-legacy-code-and-data.md)。不修改运行时或引入依赖；旧评审目录保留原验证背景。

图中区分队列的输入、目标和调度状态，Durable 的执行进度，以及记忆的理解材料；自然语言补充、取消与分类兜底画在实际调用关系上。说明卡补充快照、召回、压缩、遗忘、工具原件和媒体 manifest。helper 状态、发送回执与用户目标完成各自核对；Windows 任务进程是否全部停止仍可保持待核实。

当前 Git 开启 core.autocrlf，生成的 HTML/JSON 会被提示在 checkout 时转换换行，破坏产物回执的字节哈希。为这两类 Archify 文本产物声明 LF；图片不受此文本规则影响。

## 实际验证

- 对照正式入口、路由、队列、执行器、状态、记忆、归档、媒体及 helper 控制源码；Archify 按固定版本检查全部引用存在与行范围。
- 最终 [finalize 回执](final/nailong-runtime.finalize-summary.json)：validate、deliver、check、browser-check 全部通过，无诊断。根目录的当前回执同步到本次结果。
- [视觉检查](final/nailong-runtime.visual-check.html)：1440×900、2048×1320 明暗主题四种截图成功；containment、readability、viewerChrome、themeStates、captures 全部通过。
- 人工查看 2048×1320 light 和 1440×900 dark。主路径、节点和关系标签可辨识；窄屏幕需要页面纵向滚动。保留 5 处带桥接的交叉及 herdr_watch 绕行，可用路径透镜追踪。一次仅调整位置的方案未通过字号检查，已恢复通过检查的布局，没有改变语义或压小字体。
- 本次只更新图及其交付说明，运行时测试未重跑。已有 [清退验收](../../../docs/legacy-retirement-acceptance-20261017.md)的 142/142 测试、类型检查和构建属于当时受检状态；[上下文验收](../../../docs/context-management-acceptance-20261016.md)与[路由验收](../../../docs/contextual-input-routing-acceptance-20261016.md)保留各自真实链路范围。
- `npm run docs:check` 通过（98 份 Markdown、403 个本地链接）；`git diff --cached --check` 通过。暂存区 candidate 与 HTML 的 SHA256 均与交付回执一致。

最终 candidate SHA256：`45025981aba8737fd88f56046d74b804ba4aa9f7d507bab111bc19638384959a`。最终 HTML SHA256：`f9d278fb4a2876a0f894b52b70856c3dd3ceb2f1e55d8d1cae7281f819746c50`。本目录 final/ 证据仅适用于这些字节，图检查不证明生产进程已加载此源码。

## 评审保留项

当前 `/steer` 输入处理已退役，但 `src/assistant/main.ts:35` 的 Telegram 菜单仍登记旧命令。图按实际输入处理标注自然语言补充；菜单问题保留为运行时维护事项，本次不扩展修改。
