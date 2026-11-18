<div align="center">

# Agent Bridge

**把旧对话接到 DeepSeek Harness，在原工作目录继续。**

在 DSH 浏览 Codex、Claude Code 等 Agent 的本机项目，接着旧对话聊，或带上项目记忆和 Skills 开一段新对话。

[图文介绍](https://wfz2006.github.io/dsh-agent-bridge/) · [快速开始](#快速开始) · [界面](#界面) · [支持来源](#支持来源)

<a href="https://wfz2006.github.io/dsh-agent-bridge/"><img src="https://raw.githubusercontent.com/wfz2006/dsh-agent-bridge/main/docs/screenshots/v0.9.0/workspace.png" width="920" alt="Agent Bridge 项目首屏显示最近三条旧对话和项目资料入口"></a>

界面演示来自 **main v0.9.0** · [GitHub Release v0.8.2](https://github.com/wfz2006/dsh-agent-bridge/releases/tag/v0.8.2) · [npm v0.8.3](https://www.npmjs.com/package/@wwwfz/dsh-agent-bridge)

</div>

## 功能

| 想做什么 | 在 Agent Bridge 里怎么做 |
| --- | --- |
| **接着旧对话聊** | 选项目和一条最近对话，核对内容后迁入。DSH 在原工作目录创建一条带历史的新会话。 |
| **用项目资料开新对话** | 按进度、项目约定和 Skills 选择资料，查看可编辑的草稿。 |
| **整理项目或交接给别人** | 置顶、归档或恢复项目，也可导出本机版和分享版 Markdown。 |

## v0.9.0 更新

- **原对话统计**在迁入预览和 DSH 会话的「来源记录」顶部。查看已读轮次、消息数、工具调用，以及源记录可提供的消息时间跨度和累计 Token。
- **来源记录按回合折叠**，可查看已保存的思考摘要、工具调用和结果，继续聊天后仍可查阅迁入时的记录。
- **完整 Skill 包按项目启用**。核对包内脚本、参考文件、资源和同名冲突后启用，可停用或恢复上一版。
- **Markdown 预览和文件链接**保留原文结构。项目内文件经过路径核对可从预览打开，导出可选本机版和分享版。

## v0.8.2 更新

- **继续旧对话放到首屏**：直接显示最近几条来源对话，预览用户与助手的文字后再迁入一条新的 DSH 原生会话。
- **项目资料按用途分组**：上次做到哪、项目约定、会话中提到的 Skills 和其他笔记分开显示；全局资料默认折叠且不自动勾选，每个项目的选择会独立保留。
- **真实数据更可靠**：自动发现 Codex `.jsonl.zst` 会话及索引中仍指向旧路径的压缩记录，大型历史按流式方式读取；运行环境包装信息不会覆盖同一消息里的真实提问。
- **权限和失败恢复更明确**：面板仅接受本机 DSH 所有者身份。草稿初始化失败时会归档空白会话并复用同一会话重试；已有草稿保持原样，可打开原会话手动恢复。

## 界面

| 原对话统计 | 为当前项目启用 Skill |
| :---: | :---: |
| <img src="https://raw.githubusercontent.com/wfz2006/dsh-agent-bridge/main/docs/screenshots/v0.9.0/source-record.png" width="440" alt="来源记录含原对话统计和折叠的工具记录"> | <img src="https://raw.githubusercontent.com/wfz2006/dsh-agent-bridge/main/docs/screenshots/v0.9.0/skill-review.png" width="440" alt="项目 Skill 包启用前显示作用范围和脚本及资源"> |
| 点会话头部的「来源记录」，再按需展开每一轮。 | 确认作用范围和包内容，再启用完整 Skill。 |

<img src="https://raw.githubusercontent.com/wfz2006/dsh-agent-bridge/main/docs/screenshots/v0.9.0/markdown-preview.png" width="510" alt="Markdown 预览中的标题、步骤列表、可点击的本机项目文件链接和表格">

<details>
<summary>更多界面（项目归档、全局资料库和主题）</summary>

| 项目归档 | 全局资料库 |
| --- | --- |
| ![归档项目和恢复操作](https://raw.githubusercontent.com/wfz2006/dsh-agent-bridge/main/docs/screenshots/v0.6.0/01-project-archive.png) | ![全局资料库](https://raw.githubusercontent.com/wfz2006/dsh-agent-bridge/main/docs/screenshots/v0.8.2/05-global-library.png) |

[Agent 图标](https://github.com/wfz2006/dsh-agent-bridge/blob/main/docs/screenshots/v0.5.1/01-agent-icons.png) · [黑色主题](https://github.com/wfz2006/dsh-agent-bridge/blob/main/docs/screenshots/v0.8.2/06-black-theme.png)

</details>

## 快速开始

**DSH Web · npm v0.8.3**

```sh
dsh plugin --profile web add @wwwfz/dsh-agent-bridge
dsh web
```

**DSH Desktop · GitHub Release v0.8.2**

1. 下载 [公开安装包](https://github.com/wfz2006/dsh-agent-bridge/releases/latest/download/dsh-agent-bridge.tgz)。
2. 打开 **DSH Desktop → 插件 → 安装插件**，选择这个文件。
3. **完全退出 DSH 后再打开**，侧栏会出现 **Agent 工作接续**。

<details>
<summary>DSH Web 离线安装</summary>

在安装包所在目录运行：

```sh
dsh plugin --profile web add ./dsh-agent-bridge.tgz
dsh web
```

</details>

**体验 v0.9.0**。从 main 克隆项目，使用 Node.js 22.13 或更新版本运行 `npm pack`，再安装生成的 `.tgz`。验收使用隔离的 Windows DSH Desktop 0.2.2-rc.3 和 DSH Web。原生会话和 Skills 需要宿主提供相应服务。macOS 和 Linux 的数据路径规则有测试覆盖。 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## 使用

1. 打开 **Agent 工作接续**，按项目名、路径、Agent 或目录状态筛选。按 `/` 定位搜索框；不同 Git worktree 会独立显示。
2. 要接着聊，直接在 **继续旧对话** 里选一条最近对话，或用 **查看全部对话** 搜索。核对消息后点 **迁入并继续**。
3. 要从现有资料开始一段新对话，展开 **用项目资料开新对话**。按进度、项目约定和 Skills 等用途挑选资料。**全局资料库** 默认折叠，也不会自动勾选；展开 **接续清单** 可核对选中内容或加入近期对话摘录。点 **预览草稿** 后可以打开新对话或导出。

> 当前项目离开筛选结果时，右侧会提示重新选择。搜索后按 `↓` 聚焦第一项，按 `Enter` 打开第一项。每个项目的资料勾选和近期会话选项会单独保存，切换项目或重启 DSH 后仍可继续。

项目详情右上角可置顶常用项目。成功在 DSH 打开交接草稿或迁入原会话的项目会进入「最近接续」，最多显示五个符合当前筛选的非置顶项目。

右上角可切换蓝色、白色或黑色主题，插件会记住选择。Agent 筛选菜单支持方向键、回车和按字母查找；已适配的 Agent 名称旁显示随包提供的官方图标（[图标来源](web/agent-icons/NOTICE.md)）。

面板打开时会自动监听 Agent 索引、会话和当前项目资料的文件变化，并在后台定时复扫。正在查看或导出资料时，列表会在关闭预览后更新；**刷新来源** 可立即复扫。

资料预览将 `.md`、`.markdown` 和 `.mdx` 排版为标题、列表、代码块、表格和引用，其余文件按等宽纯文本展示。独立面板随包加载离线 `markdown-it`。交接草稿中的助手消息也按 Markdown 排版。原始 HTML 按文字展示。

预览里的工作目录和资料来源提供 **打开** 与 **复制路径**。正文里的相对文件链接从原文档所在目录解析。点击时，Host 核对项目范围和文件身份，再通过 DSH 的 `openWorkspacePath` 打开。脚本和其他可能由系统直接运行的文件只定位。文件移动、换成越界链接或宿主无法打开时，面板会提示原因并保留复制路径。

### 继续旧对话

在提供原生会话存储服务的 DSH 中打开一个项目，首屏会显示最近三条可供预览的来源对话。点击其中一条即可查看用户和助手的消息。选择 **迁入并继续** 后，DSH 会在原目录创建一条包含这些历史消息的新会话，输入下一句即可继续。

迁入保留可读取的文字、顺序和消息角色，并带入可核实的来源记录，包括 Codex 的可见思考摘要（`summary_text`）和工具调用，以及 Claude Code 的 `tool_use` / `tool_result`。结果按源调用 ID 归到调用所在回合。预览、迁入后的来源记录和显式导出都显示回合、工具名和调用 ID。缺失结果、有据可查的失败和长输出截取均有明确标记。

预览和会话头部的 **来源记录** 都可查看 **原对话统计**。面板显示已读轮次、用户与助手消息数、保存的工具调用；源记录有足够时间戳或累计 Token 时，也会显示相应数据。统计在迁入时保存，继续聊天后仍可查阅同一份数据。

来源记录只供查阅：不会作为可重放的工具事件写回 DSH，也不会触发 shell、MCP 或把旧权限带过去。迁入后 DSH 会话头部保留 **来源记录** 入口，重启后仍可查看；宿主没有提供会话头部槽时，可从 Agent Bridge 打开同一份记录。迁入时的实际工具执行数为 0，后续新问答走 DSH 正常流程。Codex 的 `.jsonl.zst` 会话、索引中尚未更新的压缩路径和大型历史都会参与发现；大型历史采用流式读取，按文字预算保留近期问答并在预览中标记截取。此功能在 Windows DSH Desktop 0.2.2-rc.3 验证。

DSH 未能填入交接草稿时，尚未使用的空白会话会自动归档，重试会复用同一会话；如果会话已有草稿，插件不会覆盖它，可以直接打开原会话并手动补入交接资料。

### 为本项目启用原生 Skill

项目技能按可核实程度显示。**DSH 已发现**表示当前项目的原生技能目录中能读到这份定义；只有能确认实际生效副本和调用策略时，才在详情中说明模型或手动入口是否可用。**可为此项目启用**表示可以从完整包建立一份只对当前项目生效的私有快照；项目目录、其他 Agent 的用户级目录和 Codex 插件缓存中的目录技能包都按此路径处理，但全局资料仍默认折叠、不自动勾选。无法安全复制、包不完整或来源无法核实的技能才标为 **仅可带入说明**。未核实的同名技能显示 **同名，待核对**；等待 DSH 刷新时显示 **待确认**；模型与手动入口都关闭时显示 **当前模式不可调用**。没有可验证的当前会话或模式时，不把“已发现”写成“当前模式可调用”。

在「继续旧对话」预览中，只有本条对话记录能对应到本机包时才显示「沿用技能（可选）」，候选默认全不选；没有候选时这一行收起。在项目草稿预览中，同一入口来自本次明确勾选的技能。选中后点「启用并继续」，插件先展示来源、目标项目、包内脚本和同名冲突，用户确认后才保存；确认失败或 DSH 未能确认时可改为仅文字继续，不需要重复创建会话。

默认快照位于 DSH 私有目录 `~/.dsh/agent-bridge-skills/`（自定义 `DSH_HOME` 时随主目录变化），不写入项目仓库。登记状态保存在同目录的 `state.sqlite`；旧 `state.json` 首次成功迁移后保持原样，不会覆盖。只对按 DSH 规则确定的项目根生效：最近 `.git` 祖先；没有 `.git` 时使用工作目录。同名技能优先保留 DSH 已发现的原技能；只有实际包内容指纹一致时才复用，不同内容会拒绝覆盖，无法读取的外部或虚拟提供者不会当作同款。指向包外的链接、特殊文件和疑似凭证文件会阻止整包启用。预览后源文件发生变化、项目根移动或目录身份改变都会使本次确认失效。来源变化时继续保留当前已确认版本，并显示需要重新预览更新；更新后可恢复上一版。源目录被移除后，已启用的快照仍出现在独立管理入口，停用只撤销本项目登记，来源快照与其他 DSH 目录不受影响。

启用成功表示 DSH 已把完整快照登记给当前项目可见范围，不代表脚本依赖、模式权限或宿主工具已经满足。脚本和 `references/`、`assets/` 会随包保留，但插件不会自动安装环境或执行脚本。仅手动技能不会进入模型侧入口。技能引用了来源 Agent 专有工具时，Bridge 只登记技能本身，不自动检查或探测该工具是否可用；实际调用可能因当前 DSH 的模型、权限、环境或依赖而失败。原生技能服务不可用时，原有文字摘录和 Markdown 导出仍可使用。

### 整理项目

项目详情右上角可归档单个项目。批量整理时，先按 Agent、项目名或「离线」缩小范围，再点「整理」，勾选项目或全选当前结果，点「归档所选」。归档项目移入「已归档」，可查看资料、恢复项目，或撤销刚才的操作。

归档状态保存在 `agent-bridge.json` 所在目录的 `agent-bridge-archive.sqlite`，实时扫描和重启后仍保留。原工作目录、记忆、Skills 和会话记录继续留在各自的来源中。

### 读取方式

项目原有的 `.agents/skills` 和 `.dsh/skills` 由 DSH 原生发现。其他 Agent 的用户级目录、共享目录和插件缓存 Skill 可在明确选中后复制为当前项目的 DSH 私有快照；只有包不完整、含包外链接或无法安全核实的技能才退回 `SKILL.md` 正文摘录和原路径。插件通过本机已认证的 DSH Host 读取资料，面板、静态资源和 API 都要求 DSH 所有者身份；源文件与 Agent 数据库按只读方式访问。发送之后，当前会话所选的模型会收到草稿。

## 导出交接

- **导出 Markdown**：在 **用项目资料开新对话** 中勾选资料，打开 **预览草稿**，再选择 **导出本机版** 或 **导出分享版**。文件用同一份已预览资料排版：标题、来源与时间、工作目录、资料索引、各分区正文和最近对话；没有资料的分区不出现，较长内容标记截取。
- **导出 DSH 会话**：用面板右上方的 **导出 DSH 会话** 选择本机 DSH 会话，可在会话下方展开已保存的 **来源记录**，也可选择本机版或分享版。文件包含原工作目录和最近的用户与助手消息。
- **本机版与分享版**：本机版把可确认的本机来源写成 `file:` 链接，点击可在本机查看器打开；分享版不写宿主附加的绝对路径，只在知道 Markdown 保存位置时生成文档内相对链接，否则显示文件名或项目相对路径。两种格式都能离线阅读，`file:` 是否可点取决于外部查看器。
- **项目交接正文链接**从原资料目录解析，并在下载前复核目标。本机版为有效文件写入编码后的 `file:` 链接。常规分享版显示项目相对路径，已知保存位置时可生成文档相对链接。失效与越界目标以文字保留，网页链接和代码块保持原样。
- **来源记录**：导出面板里的「附带来源记录」默认关闭。勾选后才写入工具名与结果摘录，且只包含已在预览中脱敏和截取的内容。

把下载的 Markdown 放进接收项目的 `.agent-bridge/handoffs/`，刷新后即可从「上次做到哪」中选用。原工作目录不可访问时，仍可导出尚可读取的归档资料。

## 支持来源

| 来源 | 可读内容 |
| --- | --- |
| Codex、Claude Code、OpenCode、Qoder、WorkBuddy、Gemini CLI、Qwen Code | 可识别的本地工作目录和会话，以及会话中有记录的 Skill 使用 |
| Antigravity | 本地工作区信息和可关联的 CLI 提示记录 |
| VS Code 系列中的 Copilot | 可识别的工作区和工作区会话 |
| TRAE | 本地工作区元数据，以及可选 AgentsView 归档中的会话 |
| 记忆与 Skills | 项目内共享笔记与交接、相关 Agent 的可读 Markdown、共享和手动配置的 Skill 目录 |
| Agent Workspace Manager / AgentsView | 可选来源。读取 WorkspaceHub 项目档案与共享 Markdown、已有会话归档 |

插件会从当前用户的标准数据目录查找来源，也会识别 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`XDG_CONFIG_HOME`、`OPENCODE_DB` 和 `OPENCODE_CONFIG_DIR`。用 **本机来源** 查看发现情况。加密、服务端或未知格式的记忆可先导出为 Markdown。[Codex 配置实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs) · [Claude Code 配置](https://code.claude.com/docs/en/settings) · [OpenCode 数据存放位置](https://opencode.ai/docs/cli/providers/#storage)

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

## 自定义来源

<details>
<summary>配置 agent-bridge.json</summary>

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

</details>

## 卸载与构建

Desktop 在插件管理页卸载 **dsh-agent-bridge**；Web 版运行：

```sh
dsh plugin --profile web remove dsh-agent-bridge
```

从源码运行 `npm test` 和 `npm pack`。项目没有第三方 npm 依赖，安装包包含插件代码、界面、本说明和 `THIRD_PARTY_NOTICES.md`。可直接复用 DSH 官方加载接口和 MIT 许可的开源实现，相关来源和许可保留在第三方声明中。

<div align="center">
<sub>为 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 制作 · <a href="https://wfz2006.github.io/dsh-agent-bridge/">介绍页</a> · <a href="https://github.com/wfz2006/dsh-agent-bridge/issues">问题反馈</a></sub>
</div>
