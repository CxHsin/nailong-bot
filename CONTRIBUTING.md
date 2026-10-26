# 贡献指南

本指南适用于人和 agent，维护开发、验证与交付的共同流程。Agent 开始工作前还须阅读 [AGENTS.md](AGENTS.md)，并按任务定位相关 Issue 和现役 ADR。

## 开始工作

1. 阅读任务 Issue 的正文、标签、评论和验收条件，确认范围及依赖；Issue 的创建与关联遵循 [issue-tracker.md](docs/agents/issue-tracker.md)。
2. Fetch 最新 `origin/main`，记录定位与验证所用的提交。独立任务默认从它建立任务分支和 worktree；依赖其他未合并工作的任务，明确记录直接基准及依赖，避免混入无关改动。
3. 每个新 checkout 运行 `npm run hooks:install`；已有 hooks 的接入方式见 [git-hooks.md](docs/agents/git-hooks.md)。缺陷修复先用失败用例确认问题，再实现修复。

## 分支与并行开发

- 每个写入任务使用独立 worktree 和独立分支；不同会话不共用工作目录或分支。任务分支可自行开发、验证和提交，例如 `fix/<issue>-<slug>`、`feat/<issue>-<slug>`、`docs/<issue>-<slug>` 或 `chore/<issue>-<slug>`。
- 独立任务分支直接向 `main` 创建 PR，不要求先汇入 `development`。`main` 通过人评审的 PR 更新，禁止直接提交或推送；`development` 不再承担强制集成角色。
- 使用已有 worktree 前核对路径、分支、HEAD 和未提交状态；不得强制将同一个分支签出到多个 worktree。分开目录仍共用一个分支引用，不能提供提交隔离。
- 多个任务涉及同一接口或热点文件时，在 Issue 或交接中说明负责范围与依赖，再协调修改和验证顺序。不要通过替换其他任务正在使用的源码来做实验。
- 反向回归需要替换旧源码时，在从明确提交建立的独立验证 checkout 中应用精确补丁，并使用独立临时数据；记录提交、补丁和命令。验证 checkout 可以使用 detached HEAD，但不在其中提交。

### 改动大小

- 一个 PR 只做一件事：测试与它覆盖的代码放在同一个 PR；重构和行为改动拆成不同的 PR，先合重构，再合依赖它的行为改动。
- 实现中发现范围外的问题，开 Issue 记录，不顺手修改。

这一流程由维护者在 [#296](https://github.com/CxHsin/nailong-bot/issues/296) 确认（2026-10-24），替代“所有修改和提交都在 `development`”的旧决定，以隔离并行任务并支持独立交付。参考 [Joye-Co/qqbot 的贡献指南](https://github.com/Joye-Co/qqbot/blob/main/CONTRIBUTING.md)；涉及交付路径的新决定应直接更新本指南。

## 验证与交接

- 检查命令以 [package.json](package.json) 和 [CI 工作流](.github/workflows/check.yml) 为准。代码改动运行类型检查和受影响的测试，按影响范围补充构建等检查；纯文档改动核对路径、命令、链接和现役实现。
- 缺陷回归使用合成数据和离线依赖，记录修复前失败、修复后通过的用例。不要用真实 Telegram、模型或通知调用代替离线回归。
- 验证记录写明分支、基准、当前提交、相关工作区差异、实际命令、结果和测试条数；未运行的检查及原因必须明确列出。任务分支通过测试，仅能说明它对应的受检状态通过。
- 检查期间保持相关源码、测试、夹具、配置和生成输入稳定。相关输入变化后，旧结果不能作为当前交付通过的依据；重新验证受影响的保证，再更新交接。提交前核对实际暂存内容与受检内容一致。
- 共享 checkout 的例外协调、证据位置和交接字段见 [context-handoff.md](docs/agents/context-handoff.md)。这套流程仍需要工作区归属和停写协调，本地 hooks 不会自动发现所有并发写入。

设计决策与代码中看不出的约束写回现役仓库文档，遵循 [domain.md](docs/agents/domain.md)；进度由 Issue 跟踪，历史由 Git 保留。能用测试或检查守住的保证，优先写成测试或检查，文档解释原因和边界。

## 评审

人和评审 agent（包括 code-review 技能）按同一标准评审。参考 [Google Engineering Practices](https://google.github.io/eng-practices/review/reviewer/)（2026-10-26 查阅），按本仓库规模取舍。

- **合并标准**：改动让代码库整体状态变好，即可合并，不要求完美；让它变差的不合并，即使局部可用。
- **评审顺序**：设计（放在这里是否合适、是否符合现役 ADR）→ 功能与边界情况（失败、取消、重启后的行为）→ 复杂度（不为可能的需求预先设计）→ 测试（去掉改动后会失败）→ 命名与注释（解释为什么）→ 风格。前一项有问题时，后面的意见可以先不提。
- **意见分级**：必须处理的意见直接写；只是建议、作者可以不采纳的意见加 `Nit:` 前缀；需要维护者决定的写成选项和推荐，不替维护者决定。
- **分歧**：先看技术事实和数据，其次看现役 ADR 与本指南，最后才是个人偏好。作者不同意时回复理由；仍无法达成一致的，交给维护者决定。

## 证据与脱敏

Issue、PR、验收记录和交接都遵循以下约定。缺陷和功能 Issue 使用 [Issue 模板](.github/ISSUE_TEMPLATE/)，通过 `gh issue create` 创建时也先读取模板并按结构填写；PR 使用 [PR 模板](.github/pull_request_template.md)。

- 区分“已复现（注明环境）”“源码阅读确认”和“推测（需复现）”；推测写明如何确认。源码位置使用固定提交的永久链接 `blob/<完整 SHA>/path#Lx-Ly`，不使用会移动的 `main` 链接。
- 不公开凭据和身份标识：`.env` 中的 token、API key 只写键名；Telegram 的 Bot token、用户 id、chat id 和 message id 用“<主用户>”“<会话>”等占位符代替。
- 不公开个人数据：`ASSISTANT_DATA_DIR` 下的对话、SELF、Akasha 记忆与档案、上传文件及工具原件，只引用合成数据或脱敏后的最小片段；本机路径写成 `<数据目录>`、`<维护者主目录>`。
- 日志、截图、trace 和 acceptance 输出按同一规则脱敏后再贴；不确定能否公开时，只写摘要数字和结论。

## 提交与交付

提交标题遵循 Conventional Commits：`<type>(<scope>): <summary>`，scope 取实际模块名。正文写清问题、结果，以及做法不显然时的原因，篇幅以几段为限。用 `Fixes #N` 关闭对应 Issue；仅作背景或尚未完整解决时使用 `Refs #N`。验证段记录实际执行的检查和结果；涉及测试时写明条数，修复缺陷时附上去掉修复就会失败的用例。

完成本地提交后，向维护者说明改动、验证结果和剩余限制，等待明确同意推送。获准后推送当前任务分支，创建或更新该分支指向 `main` 的 PR。PR 描述按 [PR 模板](.github/pull_request_template.md)的结构填写，通过 `gh pr create` 等 CLI 创建时也先读取模板；说明具体问题、修改后的行为、验证证据、合并风险和部署影响。交付 PR 链接后停止，由维护者决定是否合并。

合并后 fetch 并同步本地 `main`；其他活跃任务自行同步基准并重新验证受影响的内容。worktree 由其负责人确认交接完成、无待保留改动后再清理；清理已合并分支使用 `scripts/clean-branches.mjs`，按 [branch-cleanup.md](docs/agents/branch-cleanup.md) 先预览并遵守停止条件。不要用重置或强制删除处理未提交、未合并或其他任务持有的工作。
