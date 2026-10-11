# 本地分支保护

每个新 checkout 运行一次 `npm run hooks:install`，将本仓库的 `core.hooksPath` 设置为 `.githooks`。安装程序遇到其他 hooks 路径会停止，保留已有配置；先把保护逻辑接入已有 hooks 再安装。

`pre-commit` 只允许在 `development` 提交，包含空提交；分离 HEAD 也会被拦截。随后执行 `git diff --cached --check`，暂存差异存在尾随空格等空白错误时立即拒绝提交。修正工作区后须重新暂存，检查针对实际提交内容。`pre-push` 检查 Git 提供的每个远端目标引用，拦截创建、更新和删除 `refs/heads/main`，因此 `git push origin HEAD:main` 也会被阻止。通过 GitHub PR 合并后，用 fetch 和分支同步更新本地 main。

hooks 是每个 checkout 的本地配置，需要 Git hooks 的 shell 和 PATH 中的 Node.js；Git for Windows 已提供 shell。显式跳过 hooks 的命令不在保护范围内。现有 CI 继续运行类型检查、测试和构建。
