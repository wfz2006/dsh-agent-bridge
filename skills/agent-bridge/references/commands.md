# Agent Bridge 命令

以下以脚本名简写。通过 DSH 的 Shell 运行时，使用 `node` 加载 Skill 目录里的 `scripts/runtime/src/skill-cli.js`，再传入命令和参数。项目命令可省略 `--project` 使用当前工作区。跨项目操作先找出确切目录。

## 找项目、会话与资料

- `projects --query '项目名'` 列出匹配的本机项目、目录、来源和在线状态。`--include-archived` 同时显示已归档项目。
- `inspect --project '项目目录' --agent codex --query '标题或资料名'` 搜索该项目的会话和资料。`--page 2` 查看下一页。列表中 `moreConversations`、`moreMemories` 和 `moreSkills` 表明对应类别还有下一页。目录离线时，可以用来源里记载的原目录继续查看旧会话和导出。
- `inspect --no-history` 只查看项目资料。用户明确要查看来源 Skills 或全局记忆时，分别加 `--include-skills` 或 `--include-global`。将相同的范围选项带到 `asset` 和 `handoff`。
- `asset --asset '<资料 ID>'` 查看资料正文。用 `--page 2` 查看下一段。`truncated` 表示原文超过读取上限。
- `project-state --operation pin` 置顶。用 `unpin` 取消置顶，`archive` 归档，`restore` 恢复。这些操作和原插件共用项目状态。

## 查历史、保存附件

- `history --session '<会话 ID>'` 查看一页来源记录，包括文本、可读取的工具过程、附件元数据和缺失项。
- `history --session '<会话 ID>' --turn 3` 只查看第 3 轮。结果里出现 `nextCursor` 时，用相同的项目、来源、会话和回合参数再加 `--cursor '<当前位置>'`。源档案变化时从该会话第一页重新查看。
- `attachment --session '<会话 ID>' --attachment '<附件 ID>' --output '附件路径'` 保存可读取的附件。用历史页返回的 `attachmentId`。已存在的输出文件会保留。只有原始记录内嵌的数据或来源范围内仍可读取的文件能保存。
- `history --session '<会话 ID>' --output '会话.md' --format local` 保存完整可读取历史。加 `--include-trace` 包含工具调用和结果。`--format share` 自动替换正文及工具记录中识别到的本机路径、邮箱、IP 和凭据。分享前打开文件，检查是否还有用户不想公开的内容。

## 生成接续稿

- `handoff --session '<会话 ID>' --asset '<资料 ID>'` 合并已选会话与资料。需要多份资料时重复 `--asset`。省略会话 ID 会选最新可读会话，只交接资料时加 `--no-history`。
- `handoff --output '交接.md' --format local` 保存本机 Markdown。`handoff --format share` 在终端显示自动脱敏的分享版，可加 `--output '分享.md'` 保存。两个选项都省略时，返回供当前对话使用的接续草稿。
- 原工作区离线时可以从档案交接。开始实际开发前，请在 DSH 打开用户指定的新工作目录。

## DSH 原生迁入和 Skill 启用

已安装 Agent Bridge 插件时，在侧栏 **Agent 工作接续** 打开确认好的项目。用户要创建完整的 DSH 原生历史时，找到已选会话，打开预览并使用 **迁入并继续**。原目录不可访问时，可在迁入预览里选另一个本机目录。

用户要启用来源 Skill 时，先用 `skill-info --asset '<Skill ID>'` 核对来源、项目范围、包内文件和脚本。用项目资料中的 Skill 启用预览完成登记。这样可以使用插件的同名检查、确认和撤销。只需要将 Skill 的说明带入交接时，用 `handoff --include-skills --asset '<Skill ID>'`。

DSH 原生对话导出使用插件的 **导出 DSH 会话**。独立 Skill 的 `history` 用来读取外部来源档案。
