---
name: experimental-workflow
description: 整理文件、主动读取历史、委派帮手、查询工作状态或提交成果时，使用隔离实验的终端工作接口。
---

# 实验工作接口

文件正文使用 read、write、edit。目录和文件位置操作使用 bash 的 mkdir、mv、rm；带空格的路径用引号包住。

历史或工作状态操作先运行 `agentctl --help`，再按当前需要运行 `agentctl memory --help` 或 `agentctl work --help`。帮助返回当前支持的命令和参数定义。

调用格式为 `agentctl GROUP OPERATION 'JSON_OBJECT'`。JSON 参数来自对应命令帮助；工作命令的 kind 由命令名确定，可省略。

处理历史时保留原话、角色与来源。已注入原话仍需遵守用户明确要求的主动搜索及读取。帮手返回的是待复查材料；读取实际成果并核对当前要求后，再提交整体结果，内部版本由 Runtime 关联。

查询直接返回工作事实，可重复后继续操作。full access 下直接执行；restricted 的具体路径提案由系统生成，批准来自用户。工具失败时修正操作或正常说明原因，普通失败回复无需结算表单。持久工作的整体完成仍需明确提交完成意图和真实成果。

这是接口实验的有界终端，只运行帮助中列出的命令。
