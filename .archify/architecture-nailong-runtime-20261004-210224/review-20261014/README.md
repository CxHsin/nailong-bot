# Codemap 更新与评审

日期：2026-10-14。源码基准：`5b93ef399a2e92d7a278252f8ff84d1367a185c4`（development）。旧图基准：`d8aacac84f8ac66bc6e5ad794ab6e67a4bbe9fc4`。

## 价值、成本与影响

旧图指向已删除的 `src/personal/`，仍展示 Host、Task、Akasha、计划和冻结成果，无法导航当前入口。按 [ADR-0010](../../../docs/adr/0010-native-pi-assistant.md) 与实际调用关系，更新为 Telegram/CLI → Assistant Service → Native Pi Session，并展示原生工具、MCP、Skills、模型、发送回执及 herdr 后台观察，值得立即更新。

复用 Archify 3.0.1 和原 HTML 路径，仅修改生成文档。12 个组件、16 条关系，每个组件最多三个固定版本源码引用。保留旧 review 目录作为历史证据；旧日期的父目录保留访问兼容，标题与本次 receipts 指向当前版本。无需运行时依赖或实现改动。

图中服务不再承担通用权限或成果验收协议；herdr_watch 只观察已派发帮手，主助手检查真实成果。旧 Host/Task/Akasha/Plan 不读取、不迁移，历史诊断不画成生产关系。发送回执、草稿与用户目标完成分别说明。运行证据引用 [验收记录](../../../docs/pi-assistant-acceptance-20261014.md) 和 [实机补充](../../../docs/pi-assistant-live-20261014.md)，Claude 成功编码仍待验收。

## 实际验证

- 全部源码引用检查文件存在与行范围，并核对关键入口、会话、发送及帮手观察实现。
- `archify finalize architecture`：validate、deliver、check、browser-check 全部通过，无诊断。
- `archify visual-check --require-provenance`：1440×900、2048×1320 明暗主题四种截图成功；containment、readability、viewerChrome、themeStates、captures 全部通过。
- 人工查看 2048×1320 light 与 1440×900 dark，主路径、组件、箭头和说明卡片可辨识，无组件遮挡。自动路由存在交叉桥接与绕行，可用路径透镜逐条追踪。
- `npm run docs:check`、`git diff --cached --check` 通过。此次仅更新图与生成文档，未重新运行运行时测试；图中的 93/93 是已有验收记录。

最终 HTML SHA256：`09a7ed2692e7ea29dd1a8581f501967d0e55e98e4065570b08d7b86b07a52fdb`。本目录证据适用于该 HTML；图与浏览器检查不证明端到端工作完成。
