# 双向评审记录（2026-10-14）

按 [code-review skill](C:/Users/Cx/.codex/skills/code-review/SKILL.md) 对实施基准 `727a294293463332e55558fa3e5ba518719d6890` → 实现提交 `7930a79922b64fac64ad661fc1156d3a1c20e6c2` 进行两个独立只读评审；修复后分别核对相关差异。规格 [#196](https://github.com/CxHsin/nailong-bot/issues/196)，实施 [#197](https://github.com/CxHsin/nailong-bot/issues/197)。

## Standards

发现 2 项，均已修复：

- P1：herdr 查询/read 等待期间 `/reset` 替换会话，回传仍可能注入旧 Session，违反 ADR-0010 的正确主会话归属。现在在接受队列内按 conversation/helper 身份重新取得当前对象；延迟 read 跨 reset 回归断言仅一个模型回传、无旧历史且用户收到回复。
- P2：`opened` 清理集合一直保留已 dispose 的会话，反复 reset 留存旧上下文。现在 reset/close 移除已处置对象。

修复复核确认两项已解决。其余当前说明、历史退役记录、提交格式与验证证据符合项目规则；没有需采取行动的额外代码气味。

## Spec

发现 3 项代码问题，均已修复；另有 1 项完整真实验收缺口：

- P1：回传到 reset 后的旧 Session，与“用户输入和回传在同一主 Session 中安全排序”不符。修复同 Standards 第一项。
- P1：新会话首个助手回复前，Pi 的回执仅在内存，提前写 `delivered=true` 会在崩溃后丢失结果。现在确认实际 JSONL 的终态 custom_message 回执。回归复制首次回复前的磁盘边界，再重开该数据，断言结果重新接回。
- P2：可见结果刚完成、观察轮询尚未确认时立即 reset，已知结果可能重复。现在 reset 保存帮手记录前核对旧 Session 的磁盘回执；回归断言结果请求只有一次。
- 部分验收：真实 Telegram 往返、真实模型的插话/补充/停止/重启矩阵及 Claude 成功编码尚未完成。Claude ds 402 是用户已确认的额度问题；保持配置，不以替身或 Codex 成功代替 Claude 验收。见 [完整记录](pi-assistant-acceptance-20261014.md)，Issues 保持开放。

独立评审者针对修复运行 runtime 7/7 通过；最终综合验证 88/88 通过，类型检查与构建通过。未发现未经要求的范围扩张，无剩余阻断代码发现。

Standards：原 2 项、剩余 0 项；Spec：原 3 项代码问题与 1 项真实验收缺口，代码剩余 0 项，真实验收缺口保留。
