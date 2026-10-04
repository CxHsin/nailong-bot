# Prompt cache 与控制命令

Telegram owner 私聊输入 `/` 可发现命令；启动时自动同步中文菜单。菜单同步失败会写诊断，普通聊天继续启动，下次启动重试。

Telegram 和 CLI `chat` / `send` 共用以下 Host 命令：

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看实际支持的命令与参数 |
| `/kvcache` | 查看当前 Conversation 最近 4 次模型 Run 和累计缓存用量 |
| `/reset` | 等待前面的工作结束，再开始新模型上下文；保留原始日志和累计用量 |
| `/prompt` | 查看当前 Conversation 的 bot 提示词 |
| `/prompt set 提示词` | 设置提示词，下一次普通 Run 生效 |
| `/prompt reset` | 恢复默认提示词 |
| `/forget 节点引用` | 排除旧轮次的记忆召回、学习和模型上下文，保留原始日志 |
| `/forget` | 回复 Telegram 目标消息时选择该轮次；目标不明确时只提示选择 |
| `/memory log 节点引用 [字符位置]` | 分页诊断查阅原始日志；不恢复已遗忘记忆，不调用模型 |

未知命令和错误参数返回帮助或用法。纯文字命令不生成模型 token；图片消息的 caption 仍作为普通多模态输入处理。Telegram 支持 `/kvcache@当前bot`，发送给其他 bot 的命令不会执行。CLI 使用同一个 `--conversation-id` 可查询同一 Conversation。

## `/kvcache` 的统计口径

- 最近 4 次：当前 Conversation 实际发起过执行模型调用、且已结束的 Run，按持久终态顺序从新到旧排列；包含失败和取消，但不包含控制命令和尚未调用模型就取消的 Run。
- 每个 Run 汇总全部实际执行调用，包括工具迭代、协议纠正和真实重试。相同调用的恢复记录不会重复计数。
- 显示命中、未命中和总输入 token。命中率为命中 token 总数除以输入 token 总数，使用 token 加权。
- 缺少 Provider usage 的调用显示“数据缺失”和测量覆盖度，不能解释成零消耗。零输入的命中率显示“不可用”。
- 摘要等辅助文本模型调用单独列出，不混作普通执行调用。Embedding 用量不在本功能范围内。
- 累计基于 Runtime Log，与 reset、重启、Channel 切换无关；不同 Conversation 隔离。无法明确归属的旧调用不计入当前累计，并显示覆盖提示。
- 当前报告以 token 计量；费用没有可靠估算依据时显示“不可用”，也不代表 Provider 账单。

## 缓存行为

DeepSeek 默认自动缓存重复输入前缀，属于 best effort。Host 稳定系统提示词、工具声明及已确定的历史输入；日期与自动记忆引用作为有持久快照的当前输入补充，追加到历史之后。临时 UI 状态和命令报告不进入模型上下文。

提示词变化、重置、遗忘和必要的上下文压缩仍会生效，可能使缓存前缀变化。本功能不提供缓存开关、服务端清空、保留时间设置或本地回答缓存，也不承诺固定命中率。

相关设计和验收规格：[结论 #70](https://github.com/CxHsin/nailong-bot/issues/70)、[规格 #71](https://github.com/CxHsin/nailong-bot/issues/71)、[实现任务 #72](https://github.com/CxHsin/nailong-bot/issues/72)。
