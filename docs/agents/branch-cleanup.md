# 清理已合并分支

在 `main` 或 `development` 上执行：

```sh
node scripts/clean-branches.mjs
node scripts/clean-branches.mjs --apply
```

默认仅预览；`--apply` 删除列出的本地和 origin 远程分支。脚本先 fetch，以最新 `origin/main` 为合并依据，保留 `main`、`development`，跳过符号引用。发现未合并分支或其他 worktree 使用的任务分支时，整批停止，不删除任何分支。

远程删除使用原子推送和提交位置校验，防止删除 fetch 后被他人更新的分支；本地删除使用 `git branch -d`，不强制删除。清理失败时检查输出，解决原因后重新预览。脚本不会清理未跟踪文件。
