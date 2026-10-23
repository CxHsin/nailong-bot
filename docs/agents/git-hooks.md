# 本地分支保护

每个新 checkout 运行一次 `npm run hooks:install`，将本仓库的 `core.hooksPath` 设置为 `.githooks`。安装程序遇到其他 hooks 路径会停止，保留已有配置；先把保护逻辑接入已有 hooks 再安装。

`pre-commit` 允许非 `main` 的本地分支提交，包含任务分支和空提交；在 `main` 或分离 HEAD 上提交会被拦截。随后执行 `git diff --cached --check`，暂存差异存在尾随空格等空白错误时立即拒绝提交。修正工作区后须重新暂存，检查针对实际提交内容。

`pre-push` 检查 Git 提供的每个远端目标引用，拦截创建、更新和删除 `refs/heads/main`，因此从任何任务分支执行 `git push origin HEAD:main` 也会被阻止。向任务分支推送仍须用户明确授权，这项授权不由 hook 判断。任务分支直接通过 PR 合入 `main`，流程见 [CONTRIBUTING.md](../../CONTRIBUTING.md)；合并后用 fetch 和分支同步更新本地 main。

安装脚本写入仓库本地配置；linked worktree 通常共享这份配置，`.githooks` 相对各自的工作目录解析，因此每个新 checkout 都应运行安装命令确认可用。需要 Git hooks 的 shell 和 PATH 中的 Node.js；Git for Windows 已提供 shell。Hooks 不负责阻止普通文件写入、判断分支是否被多个目录共用，或证明验证期间输入稳定；显式跳过 hooks 的命令也不在保护范围内。现有 CI 继续运行类型检查、测试和构建。
