## 开始工作

先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，按共同流程建立独立任务分支和 worktree、验证并交付。任务分支直接向 `main` 创建 PR，不要求汇入 `development`。

## Agent skills

### Issue tracker

`grillme` 的结论、`to-spec` 的规格和实现任务都发布为 GitHub Issues。创建、读取和关联 Issue 时遵循 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认的五个 triage 标签。See `docs/agents/triage-labels.md`.

### 检索与交接

检索长文档、处理输出截断或交接任务时，读取 [context-handoff.md](docs/agents/context-handoff.md)。

退役 API 或迁移执行入口时，按 [refactor-review.md](docs/agents/refactor-review.md) 核对当前说明、历史记录和验证证据。

### Domain docs

领域术语见根目录 `GLOSSARY.md`；按任务从 [ADR 索引](docs/adr/README.md)选择现役决策。文档读取与更新遵循 [domain.md](docs/agents/domain.md)。

修改上下文恢复、压缩或记忆注入时，先读取 `docs/adr/0012-layered-memory-and-stable-context.md`，核对现役记忆、快照与 Durable 的职责。研究旧实现时再读取 `docs/adr/0003-recent-turn-context.md` 和 `docs/context-diagnostics.md`；旧离线工具已按 ADR-0014 退役。

## 分支与提交

Agent 可以在自己的任务分支上提交。推送须获用户明确同意；获得同意后，读取并使用 [pr 技能](C:/Users/Cx/.codex/skills/pr/SKILL.md)，撰写当前任务分支 → `main` 的 PR 标题和描述。交付 PR 链接和验证结果后停止，不执行合并。

Agent 的实质贡献在相应提交加 `Generated-by: <tool>` trailer；人始终是贡献责任人，评审与是否合并由人决定。提交格式、验证证据和分支清理遵循 [CONTRIBUTING.md](CONTRIBUTING.md)。
