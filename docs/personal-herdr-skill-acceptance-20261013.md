> 2026-10-14 历史记录：本文的旧 Host/Task、权限与结算、记忆或实验行为已从在线入口退役。当前行为见 [ADR-0010](adr/0010-native-pi-assistant.md)；当时证据保留，不能作为新版保证。源码基准为 727a294293463332e55558fa3e5ba518719d6890。

# herdr skill 主会话验收（2026-10-13）

对应 [规格 #177](https://github.com/CxHsin/nailong-bot/issues/177)、[闭环任务 #179](https://github.com/CxHsin/nailong-bot/issues/179)。此记录证明 skill 路径的真实正常运行闭环，不证明自动跨重启恢复或其他模型/CLI 路径。

## 环境与入口

通过与 Telegram/CLI 相同的 `createPersonalRuntime` / Host 用户输入入口调用实际配置的主模型（别名 ds），使用独立临时数据目录及能力配置，加载本项目 herdr-workflow。没有连接生产 Telegram，关闭了此次无关的网页和 embedding 服务。生产数据库只读检查为 0 个 Task、0 个 herdr Task。

herdr 0.8.2，本机为 Windows。主 Shell 是 Git Bash，任务 prompt 用 PowerShell 文件读取再以参数传递。主会话通过现有 work_permission 提出临时目录 trusted/network 权限；验收驱动核对具体提案后，依据此次用户已确认的实施授权通过 Host 确认，未绕过权限存储。

本机仅发现桌面应用附带的 Codex CLI 0.162.0-alpha.17.2，而非独立 CLI 安装。新 pane 的 PATH 没有该可执行文件目录，修正只限本任务 pane。默认启动提示缺少完整本地包；依据本版本帮助使用 `--no-daemon` 后真实启动成功。界面显示 GPT-6.1-Sol、default 推理；请求参数为 danger-full-access / ask-for-approval never，实际可修改文件和执行测试。没有安装软件、修改 CLI 全局默认或切换用户模型配置。独立 CLI 为更稳定的部署选择，此次未验证。

## 可重复的任务与结果

临时仓库初始 development 为 d21727d，sum.mjs 错将加法写成减法。初始运行 check.mjs 的第一项断言失败：sum(2,3) 为 -1，期望 5。检查还包含 sum(-1,1)=0，共两项断言。

主 Session 按 skill 执行：

1. 查询现场，在基于该 development 的独立 worktree 中启动 Codex，保存 session/workspace/pane/agent 标识。
2. 从 UTF-8 文件传递中文、多行及反引号任务，使用内置 wait 并读回实际状态。第一次 prompt 回执为 agent_prompt_stalled，但终端和产物证明已经接收执行；本体查询后继续等待，没有盲目重复发送。
3. 帮手只修改 sum.mjs，为两数之和，实际检查输出 `2 checks passed`，退出码 0；check.mjs 保持不变。
4. 主体自行核对 diff、基准、状态，独立执行同一检查，而非仅转述帮手结论。
5. 接回临时原仓库 development，复查两项断言通过、仅预期文件改变，提交 5c9265c。该隔离仓库没有远端，未推送；实际项目提交推送另行完成。
6. 关闭本任务 pane，核对 agent list 为空、原 shell PID 不再存在。最后一个 pane 关闭后 workspace 消失，改用已经核对的 Git checkout 路径移除 worktree。最终 worktree list 仅余原仓库，任务 checkout 不存在，原仓库检查仍通过。

Host 最终保存根工作 `completed`、result.verified=true、partial=false，并冻结验收 Markdown，SHA256 为 `58a0a54c8a5a61fca05e6714b78c47e1c832eb80f2c7b86f03eb7dd50851253c`。53 个动作成功；两项失败动作分别经实际现场核对记为 failed，最终没有 unknown/dispatching 动作。主 Session 的完整收尾结果保存在该工作结果，而非仅依赖终端 done。

## 实测修正与边界

- 两条并行 Shell 调用触发同一工作的未结算动作检查；第一条成功、第二条未派发。skill 增加逐条调用并等待回执规则，没有修改编排程序。
- 默认两分钟主 Session 上限不足以完成启动排查，临时验收调整为十五分钟。累计 token 预算先后触及 50万、100万、150万阈值，成果和现场保留后分段续接；最终只核对已保存的完成事实。验收的临时预算校准不改变生产默认，也不构成无限执行保证。
- 中断后先核对实际 CLI/pane/进程/产物，不重复启动、不补造成功记录。演示了本体驱动的对账接续，不证明自动后台续接。
- 清理命令必须考虑关闭最后 pane 后 workspace 已消失；skill 已明确 Git 路径清理分支。
- Claude auto、独立安装的 Codex CLI、其他模型、长期无人值守、自动通知及 Host 统一停止外部进程未验证。
- 原始验收目录、SQLite、Session、prompt、终端读回及脚本保留在本机临时目录 `nailong-herdr-177-acceptance`。本记录只保留可公开的验证事实，不含凭据。
- herdr 服务保持运行；保留临时原仓库及证据。没有触碰其他项目或生产数据。
