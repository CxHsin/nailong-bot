## Agent skills

### Issue tracker

`grillme` 的结论、`to-spec` 的规格和实现任务都发布为 GitHub Issues。创建、读取和关联 Issue 时遵循 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认的五个 triage 标签。See `docs/agents/triage-labels.md`.

### Domain docs

采用 single-context 布局：根目录 `CONTEXT.md` 和 `docs/adr/`。See `docs/agents/domain.md`.

## 分支与提交

开始修改前创建或切换到对应任务分支；提交和推送都在该分支上进行，不直接向主分支提交或推送。

分支与提交标题遵循 Conventional Commits：分支 `<type>/<描述>`，提交标题 `<type>(<scope>): <summary>`；scope 取实际模块名。文档修改可使用 `docs/git-workflow` 分支和 `docs(agents): 规范分支与提交流程` 这样的提交标题。

提交正文写清问题、结果，以及做法不显然时的原因，篇幅以几段为限。用 `Fixes #N` 关闭对应 Issue，`Refs #N` 表示仅作背景。验证段写实际跑过的检查和结果；涉及测试时记录测试条数，修复缺陷时附上去掉修复就会失败的用例。

agent 的实质贡献在相应提交加 `Generated-by: <tool>` trailer。agent 可以在任务分支上提交和推送；人始终是贡献责任人，评审与合并由人决定。
