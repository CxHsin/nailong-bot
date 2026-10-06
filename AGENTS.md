## Agent skills

### Issue tracker

`grillme` 的结论、`to-spec` 的规格和实现任务都发布为 GitHub Issues。创建、读取和关联 Issue 时遵循 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认的五个 triage 标签。See `docs/agents/triage-labels.md`.

### Domain docs

采用 single-context 布局：根目录 `CONTEXT.md` 和 `docs/adr/`。See `docs/agents/domain.md`.

## 分支与提交

每次修改前切换到 `development` 分支，并同步最新 `main`；所有改动先在 `development` 上完成验证、提交和推送，不直接向 `main` 提交或推送。

提交标题遵循 Conventional Commits：`<type>(<scope>): <summary>`；scope 取实际模块名，例如 `docs(agents): 规范分支与提交流程`。

提交后向用户说明改动和验证结果，等待用户明确同意合并。获得同意后，读取并使用 [pr 技能](C:/Users/Cx/.codex/skills/pr/SKILL.md) 撰写 PR 描述，创建或更新 `development` → `main` 的 PR，再通过 PR 合并。合并后同步本地 `main` 和 `development`，保留这两个分支。

清理已合并分支时使用 `scripts/clean-branches.mjs`；预览、执行方式和停止条件见 [分支清理](docs/agents/branch-cleanup.md)。

提交正文写清问题、结果，以及做法不显然时的原因，篇幅以几段为限。用 `Fixes #N` 关闭对应 Issue，`Refs #N` 表示仅作背景。验证段写实际跑过的检查和结果；涉及测试时记录测试条数，修复缺陷时附上去掉修复就会失败的用例。

agent 的实质贡献在相应提交加 `Generated-by: <tool>` trailer。agent 可以在 `development` 上提交和推送；人始终是贡献责任人，评审与是否合并由人决定。
