# DeepSeek Harness for VS-Code

<div align="center">

在 VS Code 中直接使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)——完整聊天界面、`@dsh` 内置聊天参与者、回合级 Git 回退,与 Web 端实时双向同步。

[![Version](https://img.shields.io/badge/version-0.11.1-blue)](https://github.com/foorgange/DeepSeek-Harness-for-VS-Code/releases)
[![VS Code](https://img.shields.io/badge/VS%20Code-%3E%3D1.90-007acc)](https://code.visualstudio.com)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-lightgrey)](https://github.com/foorgange/DeepSeek-Harness-for-VS-Code)

</div>

<img width="1024" alt="会话截图 1" src="https://github.com/user-attachments/assets/e9881be7-332c-4591-9590-26e487802e5e" />
<img width="1024" alt="会话截图 2" src="https://github.com/user-attachments/assets/ab613456-637e-4dd6-b23c-ba4d0f49324a" />
<img width="1791" height="1080" alt="屏幕截图 2026-08-22 155444" src="https://github.com/user-attachments/assets/2340ce83-bb13-4fa5-84bb-1a6836cf5b14" />
<img width="1882" height="1424" alt="屏幕截图 2026-08-22 155439" src="https://github.com/user-attachments/assets/cdd5f8ef-a449-4397-acb7-2065b6999b61" />

---

> **个人修改版(fork:foorgange)/ Personal fork (foorgange)**
>
> 本仓库是 [NEXTINDIE/DeepSeek-Harness-for-VS-Code](https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code) 的个人 fork 修改版,在原版基础上深度定制,包含大量个人改动(部分改动已以 PR #3~#6 回馈上游)。
>
> This is a personal fork of [NEXTINDIE/DeepSeek-Harness-for-VS-Code](https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code), deeply customized beyond the original (PRs #3~#6 were contributed back upstream).

### 贡献者 / Contributors

> 由于本仓库是 fork 仓库,GitHub 对 fork 网络的贡献者统计存在已知问题,首页侧边栏的"贡献者"栏会异常显示为空(实际上所有贡献者的提交均已正常记录,提交历史中的头像与署名均正确)。完整列表见 [Insights → Contributors](https://github.com/foorgange/DeepSeek-Harness-for-VS-Code/graphs/contributors):[foorgange](https://github.com/foorgange)、[Zi-Yi-Ming](https://github.com/Zi-Yi-Ming)、[NEXTINDIE](https://github.com/NEXTINDIE)(上游原作者)。
>
> Since this repository is a fork, GitHub has a known issue where the sidebar "Contributors" section of forked repositories renders as empty — even though every contribution is recorded correctly, with proper avatars and attributions in the commit history. See the full list at [Insights → Contributors](https://github.com/foorgange/DeepSeek-Harness-for-VS-Code/graphs/contributors): [foorgange](https://github.com/foorgange), [Zi-Yi-Ming](https://github.com/Zi-Yi-Ming), [NEXTINDIE](https://github.com/NEXTINDIE) (upstream author).

---

# English Documentation

## Overview

DeepSeek Harness for VS Code brings the full DeepSeek Harness agent experience into VS Code: a persistent conversation list in the secondary sidebar, each conversation opened as an editor tab alongside your code, and a built-in `@dsh` chat participant in the native VS Code Chat panel. The interface is fully bilingual (Chinese / English) and switches instantly.

## Features

### Interface & Interaction

- **Conversation tabs**: each session opens as its own editor tab, share the tab bar with code files, switch freely
- **Sidebar conversation list**: grouped by workspace, searchable, collapsible; running sessions show a highlight dot
- **Standalone chat window**: `DSH: Open Chat as Editor Tab` command, plus a secondary-sidebar sub-tab
- **Modern chat UI**: large rounded input, capsule toolbar (thinking depth / model / preset / permission), centered content with capped width
- **Motion**: message fade-in, streaming caret, button transitions — all respect `prefers-reduced-motion`
- **Line-only icons**: no emoji anywhere; monochrome SVGs adapt to light/dark themes

### Conversation Capabilities

- **Live session stats**: turns / steps / LLM and tool time / first token / tok/s / cache hits / input & output tokens, always visible, refreshed every 5 s
- **Task progress panel**: "N in progress · M pending" summary plus an expandable list (done / active / pending states)
- **Steer while running**: `Ctrl+Enter` interrupts the current turn and sends immediately; queued messages carry a "Send as steer" button
- **Turn-level Git rollback**: checkpoint dividers with "Restore checkpoint" — a review preview (per-file diff) is shown first, then the workspace is restored; `/undo` `/redo` `/checkpoints` supported
- **Approval / question cards**: tool-call approvals, multi-select questions, plan-mode confirmation
- **Live queue sync**: queue state forwarded in real time; steer / remove take effect instantly
- **Agent skill integration**: the `+` menu inserts plan mode, compact, goal, feedback commands, plus workspace `.claude` / `.codex` / Copilot instructions and skills

### Two-Way Sync with the Web

- History: sessions from the web UI open in the extension with full history (auto backfill + "load earlier" paging)
- Permission presets, models, reasoning effort: changing either side updates the other instantly
- Workspaces and their sessions: new sessions auto-attach to the current workspace and are visible in the web sidebar
- Stats / tasks / goal cards refresh in real time, matching the web UI

### Settings Panel (new in 0.11.0)

Open the gear button in the sidebar title bar (or the `DSH: Settings` command). The panel has 6 tabs:

- **General**: interface language (follow system / Chinese / English) plus web-synced general settings (web theme, conversation behavior, agent loop, shell, default permission, web search) — schema-driven forms that write to the DSH settings document, **two-way synced with the web UI**
- **Models**: set the default model (provider / model / reasoning effort), browse available models per provider, and manage API credentials (set / clear)
- **Agent Presets**: set the default preset, browse the preset list (system / user), copy or remove user presets
- **Plugins**: enable / disable DSH plugins and MCP servers (writes to `cordis.patch.yml`, effective after a server restart)
- **Skills**: overview of the skills currently available to DSH and their descriptions
- **Server**: connection status, one-click restart, and direct access to `cordis.patch.yml`

### Other

- **SCM commit messages**: a "Generate commit message" button in the source control title bar — DSH writes one from your diff
- **`@dsh` chat participant**: pick `dsh` from `@` in the native Chat panel; `/new`, `/session <ID>`, `/preset <name>` supported
- **New conversation placement**: auto-attach to the workspace of the current folder (with a directory picker fallback)
- **Long-history fix**: streaming chunks are filtered during replay — sessions with 120k+ events stay responsive
- **Emoji-free by design**: no emoji in source, plus runtime filtering (even server data is cleaned)

## Installation

**Option 1 (recommended): VS Code Marketplace**

Search `DeepSeek Harness` in the Extensions view (publisher `foorgange`) or open the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=foorgange.dsh-vscode-pro).

**Option 2: GitHub Releases**

Download the latest `.vsix` from [Releases](https://github.com/foorgange/DeepSeek-Harness-for-VS-Code/releases), then: Extensions → `...` (top right) → **Install from VSIX**.

**Requirements**: VS Code 1.90+; `dsh` available on the machine (the server auto-starts, or run `dsh web` manually).

## Usage

1. Open any folder — it is auto-adopted as a DSH workspace
2. Click the DeepSeek Harness icon in the activity bar / secondary sidebar to see the conversation list; `+` creates a new conversation
3. Chat in the editor tab, or type `@` and pick `dsh` in the native Chat panel
4. Click the gear button anytime to switch language or manage plugins

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Send message | `Enter` (Shift+Enter for newline) |
| Steer (interrupt current turn) | `Ctrl+Enter` (macOS `Cmd+Enter`) |
| Stop response | Button at the right of the input |

## Development

```bash
npm install
npm run typecheck     # type checking
npm run build         # esbuild → dist/
npm test              # smoke tests (store / render / artifact / plugin registry / settings)
npm run package       # build and package .vsix into Releases/
```

## Links

- Fork repository: https://github.com/foorgange/DeepSeek-Harness-for-VS-Code
- Upstream: https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code
- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
- PRs contributed upstream: #3 (workspace sync), #4 (whale icon), #5 (editor tabs + session list), #6 (emoji-free)

---

# 中文文档

## 简介

DeepSeek Harness for VS Code 把 DeepSeek Harness 的智能体能力完整搬进 VS Code:右侧辅助侧栏常驻会话列表,每个对话在编辑器区以独立标签页打开,与代码文件无缝切换;内置聊天参与者 `@dsh` 让你在 VS Code 原生 Chat 面板中直接与 DSH 对话。支持**中英文双语界面**,随时一键切换。

## 特性总览

### 界面与交互

- **对话标签页**:每个会话在编辑器区以独立标签页打开,与代码文件共享顶部标签栏,随意切换
- **侧边栏会话列表**:按工作区分组、支持搜索、可展开收起;运行中会话带高亮圆点
- **独立聊天窗口**:`DSH: 打开独立聊天窗口` 命令,以及侧边栏子 tab 视图
- **现代聊天界面**:大号圆角输入框、胶囊工具栏(思考深度 / 模型 / 预设 / 权限),消息区限宽居中
- **动效**:消息淡入、流式闪烁光标、按钮过渡,全部尊重 `prefers-reduced-motion`
- **纯线条图标**:全界面无 emoji,黑白 SVG 自动适配明暗主题

### 对话能力

- **实时会话统计**:轮数 / 步数 / LLM 与工具耗时 / 首 token / tok/s / 缓存命中 / 输入输出 token,常驻显示、5 秒刷新
- **任务进度面板**:「任务 N 进行中 · M 待处理」摘要条 + 展开清单(完成 / 进行中 / 待处理状态)
- **插话发送**:运行中 `Ctrl+Enter` 立即打断当前回合插入新指令;排队消息带「插话发送」按钮
- **回合级 Git 回退**:回合分隔线带「还原检查点」,点击先展示代码审核预览(逐文件 diff),确认后回退;支持 `/undo` `/redo` `/checkpoints`
- **审批 / 提问卡片**:工具调用审批、多选提问、计划模式确认
- **排队消息实时同步**:队列状态即时转发,插话 / 移除即时生效
- **智能体技能联动**:+ 菜单一键插入计划模式、压缩上下文、设置目标、记录反馈等命令,以及工作区的 `.claude` / `.codex` / Copilot 指令与技能

### 与 Web 端双向同步

- 对话历史:Web 端聊过的会话在插件端打开即可见完整历史(自动回填 + 「加载更早」分页)
- 权限预设、模型、推理等级:任一端切换,另一端即时可见
- 工作区与其中的会话:新建会话自动挂入当前工作区,Web 端按工作区分组可见
- 会话统计 / 任务进度 / 目标卡片:实时刷新,与 Web 端一致

### 设置面板(0.11.0)

侧边栏标题栏的齿轮按钮(或命令 `DSH: Settings`)打开设置面板,分 6 个标签页:

- **通用**:界面语言切换(跟随系统 / 中文 / English)+ Web 端同源的通用设置(界面主题、对话行为、Agent 循环、Shell、权限默认值、Web 搜索),基于 schema 自动渲染表单,保存即写入 DSH settings 文档,**与 Web 端双向同步**
- **模型**:设置默认模型(提供方 / 模型 / 思考深度)、浏览可用模型清单、管理各提供方的 API 凭据(设置 / 清除)
- **Agent 预设**:设置默认预设、浏览预设列表(系统 / 用户),支持复制与删除用户预设
- **插件**:DSH 插件与 MCP 服务的启用 / 禁用(写入 `cordis.patch.yml`,重启服务器后生效)
- **技能**:展示 DSH 当前可用的技能及其说明
- **服务器**:连接状态、一键重启、直接打开 `cordis.patch.yml`

### 其他

- **SCM 提交信息生成**:源代码管理面板「生成提交信息」按钮,DSH 根据 diff 生成提交信息写入输入框
- **@dsh 聊天参与者**:VS Code 原生 Chat 面板输入 `@` 选择 `dsh`,支持 `/new`、`/session <ID>`、`/preset <名>` 斜杠命令
- **新建对话归属**:自动归入当前 VS Code 目录对应工作区,可弹出目录选择器指定
- **长会话历史修复**:历史回放过滤流式分片,12 万+ 事件会话不卡死
- **界面 emoji 双层防线**:源码无 emoji + 运行时过滤(服务端数据里的 emoji 也会被滤掉)

## 安装

**方式一(推荐):VS Code 扩展市场**

在 VS Code 扩展视图搜索 `DeepSeek Harness` 直接安装(发布者 `foorgange`),或访问 [Marketplace 页面](https://marketplace.visualstudio.com/items?itemName=foorgange.dsh-vscode-pro)。

**方式二:从 GitHub Releases 安装**

下载最新 [Releases](https://github.com/foorgange/DeepSeek-Harness-for-VS-Code/releases) 中的 `.vsix` 文件:
VS Code → 扩展 → 右上角 `...` → **从 VSIX 安装**。

**要求**:VS Code 1.90+;本机可运行 `dsh`(服务器自动启动,或手动 `dsh web`)。

## 使用

1. 打开任意文件夹,扩展自动把该文件夹同步为 DSH 工作区
2. 点击活动栏 / 辅助侧栏的 DeepSeek Harness 图标查看会话列表,`+` 新建对话
3. 在编辑器标签页中与 DSH 对话;或在 VS Code 原生 Chat 中输入 `@` 选择 `dsh`
4. 需要时点击齿轮按钮打开设置面板切换语言、管理插件

## 快捷键

| 操作 | 快捷键 |
|---|---|
| 发送消息 | `Enter`(Shift+Enter 换行) |
| 插话(打断当前回合) | `Ctrl+Enter`(macOS `Cmd+Enter`) |
| 停止回复 | 输入框右侧按钮 |

## 开发

```bash
npm install
npm run typecheck     # 类型检查
npm run build         # esbuild 构建 dist/
npm test              # 冒烟测试(store 链路 / 渲染 / 产物 / 插件注册表 / 设置面板)
npm run package       # 构建并打包 .vsix 到 Releases/
```

## 相关链接

- Fork 仓库:https://github.com/foorgange/DeepSeek-Harness-for-VS-Code
- 上游:https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code
- DSH 本体:https://github.com/deepseek-ai/deepseek-harness
- 回馈上游的 PR:#3(工作区同步)、#4(鲸鱼图标)、#5(编辑器标签页+会话列表)、#6(去 emoji)
