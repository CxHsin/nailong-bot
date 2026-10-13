# herdr 上游流程改写验收（2026-10-13）

对应 [规格 #183](https://github.com/CxHsin/nailong-bot/issues/183)、[改写 #184](https://github.com/CxHsin/nailong-bot/issues/184)、[验收 #185](https://github.com/CxHsin/nailong-bot/issues/185)。当前入口为 [项目 skill](../.agents/skills/herdr-workflow/SKILL.md)，上游保留、适配与省略项见其末节。[第一版验收](personal-herdr-skill-acceptance-20261013.md)仅作历史背景。

## 环境与证据边界

使用现有 `createPersonalRuntime` / Host 用户输入入口、真实主模型、herdr 0.8.2 和桌面 Codex CLI 0.162.0-alpha.17.2；不接生产 Telegram，不改生产数据库，不新增运行时或测试 seam。正常帮手终端显示 GPT-6.1-Sol default；这是终端观察，不证明底层模型服务版本。Claude、独立安装 CLI 和其他分发版本未测。

正常只读及两个目标仓库修改场景加载 skill 提交 `40981a4`。实测又修正了持续前台 `session attach` 的后台启动、真实退出码保存，以及本机 session 管理入口不接受全局 `--session` 的例外；独立 launch 场景重新读取这些改进后验证。后续接力续接也重新读取新版，不追认早先 Session 已读新增内容。

最初使用配置别名 ds，实际主模型记录为 deepseek-flash。其服务返回 HTTP 402 Insufficient Balance 后保留现场；用户明确同意仅临时验收改用 gpt，新 Session 记录为 gpt-6.1-sol。仅进程环境覆盖 `MODEL_DEFAULT`，保留项目配置与 CLI 模型、推理、权限全局默认。

## 实际结果

| 场景 | 本次实证 | 边界 |
| --- | --- | --- |
| 当前脏内容只读 | 普通 workspace 读取未提交 sentinel 和加法；报告引用真实第 1 行，sum(2,3)=5，两项断言通过；主会话核对文件指纹、branch、diff、worktree 不变。Host completed / verified=true / partial=false，50 个成功派发，无 unknown | 读范围包含项目和 skill，写范围仅独立输出目录；未切分支、建 worktree、装 hooks 或询问脏改动。清理后实际帮手 PID 消失 |
| 非 nailong 仓库的分支规则 | 临时 AGENTS.md 指定 topic；独立 worktree 修正 sum，主会话验收接回 topic；原 SHA 120b2fc 保持，仅 sum 改动，check 不变，两项断言通过 | 未套用 development/hooks/提交推送规则；pane、agent、worktree、临时分支已清理。未预先记录 PID，进程树停止未知 |
| 无说明的当前分支基准 | 无 AGENTS.md 的仓库以 topic 为基准；同样独立 worktree、验收接回；原 SHA a0d0cae 保持，两项断言通过 | 外层 Host 在接回后遇 402，gpt 对同一工作独立核对已有成果并完成收尾，未重新派发修改；进程树停止仍未知 |
| 已授权两阶段接力 | 第一阶段真实报告经主会话读回并复现减法失败后，才创建第二阶段 worktree；真实修复后 worktree 和接回 topic 均两项断言通过，check 指纹不变；最终 Host completed / verified=true / partial=false，证据冻结，无 unknown | 第二阶段容量错误经核对无 diff/报告后原配置返工 1 轮；未授权第三阶段未派发，文件不存在。帮手 pane、PID 和 worktree 清理已实证 |
| 后台 session 启动适配 | 同一 Host 新输入重读修正；任务内 PowerShell Hidden 后台启动，核对实际客户端 PID/argv、session running 与连接；限定清理后客户端 41140、server 41952 消失，其他 herdr PID 保持 | 首轮错误 argv 实际退出 2、无 session 影响，人工对账后恢复；客户端最终退出码未取得，不将其补为 0 |
| 启动失败上限 | 首次 PATH 失败，随后两次真实 Codex 拒绝指定无效参数；三次均使用 timeout 90000，保存原生失败退出码，最终明确受阻且未派发任务 | 初次之后恰两次重试；没有删除指定参数、换配置或继续启动。失败现场保留 |
| 验收失败及接力闸门 | 冻结检查注入固定 exit 23；主会话独立确认 sum 修正但检查失败，拒绝集成为通过。另在隔离 worktree 的接力阶段真实复现 exit 23、冻结检查指纹不变，第二阶段文件不存在且未派发 | 不可修复的检查提前受阻，追加返工 0 轮；两轮耗尽另作受控补验。早先单独返工场景误用原目录 workspace，不能作修改隔离通过证据 |
| 两轮返工耗尽 | 现有 Host 执行其任务内脚本，由受控 Shell worker 在初始轮及两轮纠正产生产物 value=0；每轮读取新产物并实际运行冻结检查（期望 1），均退出 23；事件恰为 rounds 0,1,2，最终 BLOCKED，无第三轮纠正或后续阶段文件，冻结脚本不变 | 明确的故障注入，验证任务脚本的有界返工与停止闸门；不代表真实 Codex 三轮纠错或主模型逐轮决策。Host 保留 waiting，脚本执行成功不表示失败产物通过验收；失败 fixture 保留 |

四个正常 fixture 各含两项断言，检查文件均保持不变；没有为 skill 措辞新增字符串匹配测试。格式检查使用 `quick_validate.py` 的 UTF-8 模式；文档链接和 diff 空白检查另见对应提交验证正文。

## 中断、人工介入与保留现场

最初只读尝试在收尾触及临时 token 上限，且写权限提案覆盖了项目，不能作为完整通过；之后用独立输出权限场景重新验证。验收临时预算校准不改变生产默认。

同步 `session attach` 曾阻塞，驱动核对完整 argv/PID 后仅停止对应客户端，保留 server。Shell 非零、工具失败或缺失进程的纯查询曾产生 Host unknown；驱动独立核对实际影响后，将对应动作人工记为 failed，再从真实用户输入入口续接。任务内 prompt、PATH、信任提示及接收状态均按实际现场处理；没有用 done、完成标记或时间经过替代成果验收。这些人工对账不证明自动恢复、无人值守接力或 Host 统一停止外部进程。

成功场景清理已核实的帮手资源；失败和停止状态未知的现场保留。Host 执行后端的工作区另行保留，不把它当作未清理的帮手，也不停止 herdr 主服务。

原始脚本、Session JSONL、状态和证据保留在本机临时目录：

- `C:/Users/Cx/AppData/Local/Temp/nailong-herdr-183-acceptance`：准确只读权限、正常接力、后台启动及中断记录。
- `C:/Users/Cx/AppData/Local/Temp/nailong-herdr-183-repo-acceptance`：目标规则与当前分支基准、独立观察结果、同一 fallback 工作接续。
- `C:/Users/Cx/AppData/Local/Temp/nailong-herdr-183-failure-acceptance`：三次启动日志、原生退出码、冻结检查失败、接力闸门及人工对账。
- `C:/Users/Cx/AppData/Local/Temp/nailong-herdr-183-reworklimit-acceptance`：受控 Shell 补验的轮次 prompt、真实事件与产物、冻结检查、停止报告及独立核对。

这些目录不是可移植交付依赖；本记录保留可审阅事实及限制，不包含凭据。上述场景覆盖不等于所有模型或故障路径已通过，受控 Shell 补验不替代真实 Codex 连续三轮失败；两个修改场景的精确进程树停止仍未验证。
