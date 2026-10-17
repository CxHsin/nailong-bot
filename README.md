<h1 align="center">
  <img src=".github/assets/nailong-icon.jpg" alt="Nailong bot 图标" width="72" height="72" valign="middle" /> Nailong bot
</h1>

<p align="center">运行在 Windows 本机的个人助手，通过 Telegram 或终端交办工作，保存执行进度与长期记忆。</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#使用方式">使用方式</a> ·
  <a href="#架构">架构</a> ·
  <a href="docs/personal-agent-operations.md">操作说明</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A524-4C8DFF" alt="Node.js 24 或更新版本" />
  <img src="https://img.shields.io/badge/platform-Windows-4C8DFF" alt="平台：Windows" />
  <img src="https://img.shields.io/badge/Pi%20Durable-1.2.0-4C8DFF" alt="Pi Durable 1.2.0" />
</p>

## 什么是 Nailong bot

一个 Telegram bot 对应一个主 agent，负责持续对话、使用本机工具、委派工作并核查成果。你可以在手机上发送文字、图片或文件，也可以从终端接续指定会话。

- **保存工作进度。** 输入先持久接收，Pi Durable 保存模型与工具执行进度。意外重启后续接已保存的工作，复用已确认的结果；明确暂停的工作等待你继续。
- **用自然语言补充和取消。** 独立请求按到达顺序排队，补充关联已有目标，排队工作的补充保留原位置。取消会保留已有成果，并核实实际停止状态。
- **记住偏好与相处方式。** 共享长期记忆保存有来源的事实、偏好和项目主题；SELF 文件维护身份与人设。可以明确要求记住、纠正或忘记，也可以按需检索原始记录。
- **将编码交给专门的帮手。** 主助手通过 herdr-workflow 委派给 Codex 或 Claude Code，接回结果后检查真实文件、差异和验证结果。
- **本机存储，自行配置模型。** 会话、执行记录、记忆和工具原件保存在本地。模型通过 API 接入，支持配置多个别名并在会话中切换。

当前面向 Windows 本机单服务使用，Telegram 仅接收配置主人的私聊。服务器部署、群聊、多 bot，以及 cron、邮件、Slack 等主动连接器尚不在支持范围内。

## 快速开始

### 环境要求

- Windows、Node.js 24 或更新版本、npm、Git。
- 一个可用的模型 API 端点与 API Key；项目不内置共享模型账号。
- 使用 Telegram 时，需要 BotFather 创建的 bot token 和主人的 Telegram 用户 ID。
- 使用编码委派时，需要另行安装并配置 herdr 与 Codex 或 Claude Code，见 [herdr-workflow](.agents/skills/herdr-workflow/SKILL.md)。

### 安装与配置

在 PowerShell 中执行：

```powershell
git clone https://github.com/CxHsin/nailong-bot.git
cd nailong-bot
npm ci
npm run hooks:install
Copy-Item .env.example .env
```

编辑 `.env`，按 [.env.example](.env.example) 配置模型：

1. 设置 `MODEL_NAMES` 和 `MODEL_DEFAULT`，选择默认模型别名。
2. 填写对应的 `MODEL_<ALIAS>_API`、`BASE_URL`、`MODEL` 和 `API_KEY`，并核对该模型的图片支持与上下文容量。示例中的 `ds`、`gpt` 是可替换的别名；更换服务时一起更换端点、模型 ID 和凭据。
3. 保留或修改必填的 `AGENT_SYSTEM_PROMPT` 基础指令。它直接接收文本，支持带引号的多行值；身份和人设由数据目录内的 `memory/SELF.md` 维护。

先从终端发起一次请求：

```powershell
npm run send -- "介绍一下你能做什么"
```

需要持续对话时运行 `npm run chat`。这些入口直接运行 TypeScript 源码，无需先执行构建。

### 接入 Telegram

在 `.env` 中填写：

```dotenv
AGENT_TELEGRAM_BOT_TOKEN=你的_BotFather_token
AGENT_TELEGRAM_USER_ID=你的_Telegram_用户ID
```

也接受 `.env.example` 中的 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_USER_ID` 别名。然后启动服务，向 bot 发送私聊：

```powershell
npm start
```

同一数据目录同时只允许一个进程。切换 Telegram 与 CLI 前，先停止前一个进程；同一 bot 也应只由一个实例接收更新。若曾配置 webhook，先核对 long polling 的接入方式，服务启动不会自动删除 webhook。

## 使用方式

### Telegram 与终端

Telegram 支持文字、图片、document 附件、Markdown 富消息、长文分页、临时正文预览和文件交付。预览用于查看生成进展；最终发送结果另有记录，发送结果不明时不自动重发。

终端入口支持交互、单次输入、图片和逐行 JSON 输出：

| 用途 | 命令 |
| --- | --- |
| 交互对话 | `npm run chat` |
| 单次输入 | `npm run send -- "整理文件并交付结果"` |
| 分析图片 | `npm run send -- "分析图片" --image photo.png` |
| 续接 Telegram 会话 | `npm run send -- "继续" --conversation-id telegram:private:42` |
| 逐行 JSON 输出 | `npm run send -- "问题" --ndjson` |

续接示例中的 `42` 需替换为配置主人的 Telegram 用户 ID，并使用相同数据目录。

### 会话命令

| 命令 | 行为 |
| --- | --- |
| `/help` | 显示用法 |
| `/model`、`/model 别名` | 查看或切换主助手模型；Codex/Claude Code 的模型各自配置 |
| `/kvcache` | 查看当前会话最近五轮的 prompt cache 用量 |
| `/resume [批次ID]` | 继续本会话暂停的工作；省略 ID 时继续全部暂停项 |
| `/reset` | 清理主上下文，保留排队输入、执行进度、委派与长期记忆 |

直接用自然语言交办、补充或取消工作，例如“把刚才的报告改成中文”“取消整理文件，保留已经生成的材料”。当前工作的补充在执行器支持的输入边界读取。旧 `/steer` 命令已退役，收到后会提示改用自然语言。

可用 `ASSISTANT_INTENT_MODEL` 独立选择输入分类模型；未配置或判断失败时，原输入交给主助手处理。完整配置、文件限制和发送行为见[操作说明](docs/personal-agent-operations.md)。

## 架构

Telegram 与 CLI 使用同一套 Assistant Service 实现，由 nailong 管理输入与会话，Pi Durable 保存模型和工具步骤：

```text
Telegram / CLI
      ↓
Assistant Service
      ├─ nailong 持久队列：接收、去重、会话路由、优先级、FIFO 与合批
      └─ Pi Durable 1.2.0：主 agent 的模型调用、工具步骤与执行恢复
              ├─ 本机工具 / skills / 已配置的 MCP 工具
              ├─ herdr-workflow → Codex / Claude Code → 成果核查
              └─ 长期记忆 / SELF / 工具原件归档
```

队列决定哪些输入等待、补充或取消哪些工作；Durable 与外部证据确定执行进度；记忆和上下文帮助助手理解目标与历史。主助手可在派发后结束当前处理轮次，接收后续输入，再接回帮手结果。

从 [CONTEXT.md](CONTEXT.md) 了解领域术语，设计依据见[持久执行 ADR](docs/adr/0011-durable-main-agent-and-conversation-queue.md)、[输入路由 ADR](docs/adr/0013-contextual-input-routing.md)与[记忆 ADR](docs/adr/0012-layered-memory-and-stable-context.md)。

## 仓库结构

```text
src/main.ts             Telegram 正式入口
src/cli/                交互与单次输入入口
src/assistant/          当前服务、队列、Durable 接入、记忆与通道实现
.agents/skills/         项目技能，包括 herdr-workflow
test/                   自动化测试，当前接入回归为 assistant-*.test.ts
scripts/                构建、文档检查与 Git hooks 等维护脚本
docs/adr/               架构决策
docs/                   操作说明、验收记录与研究材料
CONTEXT.md              领域术语与当前设计入口
.env.example            模型、基础指令与运行配置示例
```

## 本地数据与恢复

`ASSISTANT_DATA_DIR` 默认使用 `data/pi-durable-v1`，`ASSISTANT_WORK_DIR` 默认使用启动目录。前者保存服务数据，后者用于相对路径和项目指令；重开会话沿用原工作目录。

```text
data/pi-durable-v1/
  queue.sqlite                 输入事件与批次
  queue-owner.sqlite           数据目录单服务独占
  assistant.sqlite             会话控制、帮手身份与交付记录
  assistant-memory.sqlite      记忆来源、版本、检索与快照
  memory/SELF.md               当前身份、人设与相处方式
  telegram-sends.jsonl         Telegram 发送回执
  executions/<会话 SHA-256>/   Durable 步骤、工具原件与媒体
```

- **恢复与暂停。** 确认接收前保存完整输入与材料，意外重启后续接已保存的批次和执行进度。临时模型故障最多重试 3 次，含首次共 4 次请求，基础等待 2 秒；耗尽后保留进度并暂停，等待 `/resume`，其他输入仍可处理。
- **外部操作。** 结果不明时先核实，无法确认则暂停询问。停止、抢占和 reset 不会回滚已有影响；帮手按已登记的真实身份接回，重启不会盲目重新派发。
- **基础指令与记忆。** 修改 `AGENT_SYSTEM_PROMPT` 或人工编辑 `memory/SELF.md` 后重启服务生效，保留历史与工作进度。默认“忘记”会撤回相关派生记忆并排除对应来源的自动召回，原始记录仍保留。
- **备份与旧数据。** 备份前停止服务，保留整个数据目录。现役空间不导入旧会话历史、摘要、工具轨迹、Task 或旧 Akasha；启动不会自动删除遗留资料。退役范围见 [ADR-0014](docs/adr/0014-retire-legacy-code-and-data.md)。

文件与 Shell 继承启动账户的实际权限，工作目录不是沙箱。用户和项目指令约束行动范围，发布、外发、重要删除及合并须有对应授权。MCP、额外 skills 和网页工具的接入方式见[能力配置](docs/capabilities.md)。

## 开发与验证

在 `development` 分支上开发，修改前同步最新 `main`。新 checkout 运行 `npm run hooks:install`，本地 hooks 限制提交分支并拦截向 `main` 推送，细节见[本地分支保护](docs/agents/git-hooks.md)。提交遵循 Conventional Commits；推送须经用户明确同意，通过 `development` → `main` PR 评审，由人决定合并。

常用检查命令：

```powershell
npm run docs:check
npm run typecheck
npm test
npm run build
git diff --check
```

实际运行与恢复的验证范围见各验收记录；历史实验只适用于其记录的版本和场景。

## 文档导航

| 想了解什么 | 从这里开始 |
| --- | --- |
| 配置、日常操作、附件、恢复与预算 | [主助手操作说明](docs/personal-agent-operations.md) |
| 模型、skills、MCP 与编码委派 | [能力配置](docs/capabilities.md) |
| 领域术语与架构决策 | [CONTEXT.md](CONTEXT.md) · [ADRs](docs/adr/) |
| 持久执行的受控验收与真实链路 | [切换验收](docs/durable-assistant-acceptance-20261015.md) · [真实链路测评](docs/durable-assistant-live-20261016.md) |
| 自然语言补充、取消与队列路由 | [路由验收](docs/contextual-input-routing-acceptance-20261016.md) |
| 上下文、长期记忆与工具原件 | [上下文验收](docs/context-management-acceptance-20261016.md) |
| 系统指令顺序与 SELF 文件 | [ADR-0015](docs/adr/0015-system-context-order-and-self-file.md) · [验收记录](docs/system-self-acceptance-20261017.md) |
