# Codemap 更新与评审

日期：2026-10-12。源码基准：`d8aacac84f8ac66bc6e5ad794ab6e67a4bbe9fc4`（development）。旧图源码基准：`d266078d42eb7c9d4b67c13eeff96c7ccaca400d`。

## 价值、成本与影响

旧图仍引用已删除的 Host Run 队列、Agent Host 和在线 Context Execution，不能导航当前生产入口。按 ADR-0007 更新为 Personal Host、独立 Task、Pi 原生 Session、显式计划、herdr 委派、独立验收及成果交付，修正模型配置、文件权限和恢复说明，值得立即更新。

复用已有 Archify 3.0.1 与原图访问路径，更新 candidate、HTML 和校验记录；不引入项目依赖或运行时代码。15 个组件、19 条关系保留必要的维护入口，每个组件至多三个固定版本源码引用。历史 Run/Context 仅说明迁移与离线诊断职责，避免与生产 Task 混淆。

影响限于架构导航和展示。顶部 receipts 指向本次产物；review-3 保留为旧验证历史，不能证明新版产物。旧日期目录名为兼容现有访问路径保留，页面标题和来源版本明确标记当前日期。连线存在自动桥接和绕行，视觉复核确认主路径、方向、组件与标签可辨识，无组件遮挡；路径透镜可用于逐条追踪。

## 实际验证

- `archify finalize architecture … --repo-root . --out-dir …/review-20261012`：validate、deliver、check、browser-check 全部通过，无诊断。
- `archify visual-check … --require-provenance`：1440×900、2048×1320 的明暗主题四种截图均成功；containment、readability、viewerChrome、themeStates、captures 通过。
- 人工查看本次 1440×900 light 和 2048×1320 dark 截图，确认主路径、标签、箭头、说明卡片与主题显示。
- 对 candidate 的全部源码引用检查文件存在及行范围；按当前实现核对职责、权限、迁移、验收及学习说明。
- `npm run docs:check` 与 `git diff --check` 通过。此次仅更新生成文档，未运行运行时测试。

最终 HTML SHA256：`f38f9dbca9f038e87e58637fd51bada7f81eb13f23394b5a37ef111d787f59e0`。

图与浏览器检查不证明端到端运行结果。ADR-0007 明确真实 Telegram 验收仍待完成；图中保留此限制。Claude 策略校验是执行器支持的约束，当前生产装配尚未提供对应策略。
