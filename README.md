# DSH Agent Bridge · Agent 工作接续

在 DeepSeek Harness 中查看本机其他 Agent 的项目、记忆和 Skills。选择要带入的资料后，在原工作目录打开新的 DSH 会话，接着已有分支和文件开发。

![DSH Agent Bridge 桌面工作台](docs/screenshots/v0.4.0/00-dsh-desktop-light.png)

[深色界面](docs/screenshots/v0.4.0/03-workspace-dark.png) · [交接预览](docs/screenshots/v0.4.0/02-handoff-light.png) · [紧凑布局](docs/screenshots/v0.4.0/05-workspace-compact.png)

## 安装

下载 [dsh-agent-bridge-0.4.0.tgz](https://github.com/wfz2006/dsh-agent-bridge/releases/download/v0.4.0/dsh-agent-bridge-0.4.0.tgz)，在 **DSH Desktop → 插件 → 安装插件** 填入该文件在你电脑上的完整路径。若插件管理器显示需要重启，退出并重新打开 DSH。安装完成后，侧栏会出现 **Agent 工作接续**。

使用 DSH Web 时，在包含安装包的目录运行以下命令。

```sh
dsh plugin --profile web add ./dsh-agent-bridge-0.4.0.tgz
dsh web
```

发行包只依赖 DSH 的运行时。本版在 Windows 的官方 DSH Desktop 和 Web 0.2.2-rc.1 验收，原生会话入口依赖对应的 DSH 客户端服务。macOS 和 Linux 的数据路径规则有测试覆盖，桌面运行时的实机验收以 Windows 为准。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## 使用

1. 打开 **Agent 工作接续**，按项目名、路径、Agent 或目录状态筛选。按 `/` 可以定位项目搜索框。不同 Git worktree 会独立显示。
2. 在资料区勾选记忆与 Skills。接续清单会汇总两类资料，可以移除单项或勾选近期会话。Skills 页会标记会话中记录过的使用。
3. 从接续清单打开 **预览交接**，在侧栏中核对内容，选择导入或导出。导入会在原工作目录创建 DSH 会话并填入可编辑的草稿。

面板打开时自动监听 Agent 索引、会话和当前项目资料的文件变化，并在后台定时复扫。正在查看或导出资料时，列表会在关闭预览后更新。**刷新来源** 可立即复扫。

项目原有的 `.agents/skills` 和 `.dsh/skills` 由 DSH 原生发现。其他 Agent 的 Skill 以 `SKILL.md` 正文摘录和原路径带入，DSH 可在需要时读取同目录资源。导入预览会标记截取内容。插件通过本机的已认证 DSH Host 读取资料，源文件与 Agent 数据库按只读方式访问。发送之后，当前会话所选的模型会收到草稿。

## 导出交接

- 在项目中勾选资料，打开 **预览交接 → 导出 Markdown**。文件包含已选记忆、Skill 说明、来源和已选会话摘录。
- 用面板右上方的 **导出 DSH 会话** 选择本机 DSH 会话。交接文件包含原工作目录和最近的用户与助手消息，较长的会话会标记截取。

把下载的 Markdown 放进接收项目的 `.agent-bridge/handoffs/`，刷新后即可从「记忆」页重新导入。原工作目录不可访问时，仍可导出尚可读取的归档资料。

## 来源

| 来源 | 可读内容 |
| --- | --- |
| Codex、Claude Code、OpenCode、Qoder、WorkBuddy、Gemini CLI、Qwen Code | 可识别的本地工作目录和会话，以及会话中有记录的 Skill 使用 |
| Antigravity | 本地工作区信息和可关联的 CLI 提示记录 |
| VS Code 系列中的 Copilot | 可识别的工作区和工作区会话 |
| TRAE | 本地工作区元数据，以及可选 AgentsView 归档中的会话 |
| 记忆与 Skills | 项目内共享笔记与交接、相关 Agent 的可读 Markdown、共享和手动配置的 Skill 目录 |
| Agent Workspace Manager / AgentsView | 可选来源。读取 WorkspaceHub 项目档案与共享 Markdown、已有会话归档 |

插件会从当前用户的标准数据目录查找来源。也会识别 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`XDG_CONFIG_HOME`、`OPENCODE_DB` 和 `OPENCODE_CONFIG_DIR`。用 **本机来源** 查看发现情况。加密、服务端或未知格式的记忆可先导出为 Markdown。[Codex 配置实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs) · [Claude Code 配置](https://code.claude.com/docs/en/settings) · [OpenCode 数据存放位置](https://opencode.ai/docs/cli/providers/#storage)

## 在项目里存放共享记忆

在已发现的项目目录下放入 Markdown，刷新后即可查看并导入。

```text
my-project/
  .agent-bridge/
    memory/
      current-state.md
    handoffs/
      latest-handoff.md
```

`current-state.md` 可记录当前目标、分支状态与待办。`latest-handoff.md` 可记录已完成事项、验证结果和下一步。两个目录的第一层 Markdown 会显示在项目的「记忆」页。也可把这两份文件与项目一起交给其他开发者。

## 补充来源

通常安装后即可扫描。需要指定自定义数据位置时，在 DSH 主目录创建 `agent-bridge.json`。Windows 默认目录为 `%USERPROFILE%\.dsh`，macOS 和 Linux 默认为 `~/.dsh`。自定义主目录由 `DSH_HOME` 决定，也可通过 `DSH_AGENT_BRIDGE_CONFIG` 指定配置文件的完整路径。点击 **刷新来源** 重读配置。

```json
{
  "projectRoots": ["~/projects/example"],
  "agentRoots": {
    "opencode": ["~/agent-data/opencode"],
    "claude": ["~/agent-data/claude"]
  },
  "skillRoots": ["~/shared/skills"],
  "opencodeSkillRoots": ["~/agent-config/opencode"],
  "memoryExports": {
    "~/projects/example": ["~/exports/example/current-state.md"]
  },
  "workspaceHubRoots": ["~/workspace-manager-data/workspacehub"],
  "archiveFiles": ["~/workspace-manager-data/sessions.db"]
}
```

只需填写你使用的项。相对路径从配置文件所在目录计算，`~` 指当前用户目录。配置里的 `agentRoots` 替换对应 Agent 的自动路径，填写空数组可跳过该 Agent。OpenCode 路径可以是数据目录或会话数据库文件。记忆导出接受 Markdown 文件或包含 Markdown 的目录，并与指定项目的原工作目录匹配。自定义 AgentsView 数据目录也可通过 `AGENTSVIEW_DATA_DIR` 传入。

## 卸载与构建

在 Desktop 的插件管理页卸载 **dsh-agent-bridge**，Web 版运行 `dsh plugin --profile web remove dsh-agent-bridge`。之前创建的工作区和会话可以继续在 DSH 中管理。

从源码运行 `npm test` 和 `npm pack`。项目没有第三方 npm 依赖，安装包包含插件代码、界面和本说明。
