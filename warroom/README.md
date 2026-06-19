<h1 align="center">AgentRecall War Room · 战情室</h1>

<p align="center"><strong>Your agent's memory, visualized. · 可视化你的 agent 记忆系统。</strong></p>
<p align="center">A local-first multi-page dashboard for monitoring AgentRecall across all your projects.</p>
<p align="center">本地优先的多页面仪表板，用于跨项目监控你的 AgentRecall 记忆系统。</p>

<p align="center">
  <img src="https://img.shields.io/badge/local--first-zero_cloud-blue?style=flat-square" alt="local-first">
  <img src="https://img.shields.io/badge/pages-7-7C3AED?style=flat-square" alt="7 pages">
  <img src="https://img.shields.io/badge/theme-dark_%2F_light-orange?style=flat-square" alt="dark/light">
  <img src="https://img.shields.io/badge/requires-AgentRecall_MCP-10B981?style=flat-square" alt="AgentRecall MCP">
  <img src="https://img.shields.io/badge/runtime-localhost_8080-5D34F2?style=flat-square" alt="localhost">
</p>

<p align="center">
  <b>EN:</b>&nbsp;
  <a href="#what-it-is--这是什么">What</a> ·
  <a href="#pages--页面">Pages</a> ·
  <a href="#quick-start--快速开始">Run it</a> ·
  <a href="#data-bridge--数据桥接">Data</a> ·
  <a href="#file-structure--文件结构">Files</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <b>中文:</b>&nbsp;
  <a href="#what-it-is--这是什么">是什么</a> ·
  <a href="#pages--页面">页面</a> ·
  <a href="#quick-start--快速开始">运行</a> ·
  <a href="#data-bridge--数据桥接">数据</a> ·
  <a href="#file-structure--文件结构">文件</a>
</p>

---

## What it is · 这是什么

<table>
<tr>
<th width="50%">🇬🇧 English</th>
<th width="50%">🇨🇳 中文</th>
</tr>
<tr>
<td>

**War Room is the command center for AgentRecall.**

Every session your agent saves, every correction it learns, every nightly dream run — all visible in one place. No login, no cloud, no third-party service. Just open the HTML in a browser.

Activity calendar is the centerpiece: a GitHub-style contribution heatmap showing every memory write with precise timestamps (year-month-day-hour-minute-second). Color deepens after 10 and 20 saves per day.

Runs entirely on `localhost:8080`.

</td>
<td>

**战情室是 AgentRecall 的指挥中心。**

Agent 存的每个会话、学到的每条纠正、每晚跑的梦境整合 —— 全部可视化在一处。无需登录，无需云端，无需第三方服务。直接在浏览器里打开 HTML 即可。

活动日历是核心：GitHub 风格的贡献热力图，每次记忆写入都有精确时间戳（年-月-日-时-分-秒）。每天超过 10/20 次写入时颜色加深。

完全运行在 `localhost:8080` 上。

</td>
</tr>
</table>

---

## Pages · 页面

| Page · 页面 | 🇬🇧 What it shows | 🇨🇳 显示内容 |
|---|---|---|
| **Overview · 总览** | Cross-project status at a glance: active, blocked, stale. Recent activity strip. | 跨项目状态一览：活跃、阻塞、过期。近期活动条。 |
| **Projects · 项目** | Per-project War Room — rooms, cards, agent prompt, sessions, rules, learned lessons. Click any card to drill in. | 每个项目的战情室 —— 房间、卡片、agent prompt、会话数、规则、已学习的教训。点击任意卡片进入详情。 |
| **Activity · 活动 ⭐** | Contribution heatmap calendar + full precision timeline. The most important page. | 贡献热力日历 + 全精度时间轴。最重要的页面。 |
| **Dream Health · 梦境** | Track nightly consolidation runs: succeeded / failed / files touched. Click a dream to see its files. | 追踪夜间整合进程：成功/失败/修改了哪些文件。点击梦境查看关联文件。 |
| **Palace Graph · 记忆宫殿** | Cytoscape force-directed graph of memory rooms and their relationships across projects. | 跨项目记忆房间及其关联关系的 Cytoscape 力导向图。 |
| **Install · 安装** | 13-client setup guide + install prompt (copy to tell your agent to install) + bootstrap prompt. | 13 个客户端安装指南 + 安装 prompt（复制后告诉 agent 安装）+ bootstrap prompt。 |
| **Connect · 连接** | Local storage details, last-save path, optional Supabase cross-machine sync. | 本地存储详情、最近保存路径、可选 Supabase 跨机器同步。 |

---

## Quick Start · 快速开始

**Requires [AgentRecall MCP](https://github.com/Goldentrii/AgentRecall) installed first · 前提：先安装 AgentRecall MCP**

```bash
# Clone or download this folder, then start the server · 下载文件夹后启动服务器
cd "warroom"
python3 -m http.server 8080

# Open in browser · 浏览器打开
open http://localhost:8080/AgentRecall.html
```

Navigate with the left rail. Theme toggle is at the bottom of the nav rail.

用左侧导航栏切换页面。主题切换按钮在导航栏底部。

---

## Data Bridge · 数据桥接

<table>
<tr>
<th width="50%">🇬🇧 English</th>
<th width="50%">🇨🇳 中文</th>
</tr>
<tr>
<td>

**Currently running on demo data** in `ar-data.js`. No real memory is displayed yet — this is intentional for first-run exploration.

To connect your real AgentRecall data, the planned flow is:

```bash
ar export --warroom > "warroom/ar-data.js"
```

This will generate a fresh `ar-data.js` from your actual `~/.agent-recall/` directory, replacing the demo projects with your real sessions, corrections, activity, and dream runs.

> **Status:** `ar export` is planned for a future AgentRecall release. Until then, edit `ar-data.js` directly to preview your own data — the schema is self-documenting.

</td>
<td>

**当前显示的是演示数据**，来自 `ar-data.js`。这是有意为之的 —— 方便首次探索。

连接你真实的 AgentRecall 数据，计划中的流程是：

```bash
ar export --warroom > "warroom/ar-data.js"
```

这会从你的 `~/.agent-recall/` 目录生成一个新的 `ar-data.js`，用你真实的会话、纠正、活动记录和梦境进程替换演示数据。

> **状态：** `ar export` 计划在未来的 AgentRecall 版本中发布。在此之前，可直接编辑 `ar-data.js` 来预览自己的数据 —— schema 已有自文档注释。

</td>
</tr>
</table>

---

## File Structure · 文件结构

```
warroom/
├── AgentRecall.html      # App shell — HTML entry point · HTML 入口
├── ar-theme.css          # Design tokens: colors, type, spacing · 设计系统：颜色、字体、间距
├── ar-app.js             # Nav rail, hash router, theme toggle, shared helpers · 导航、路由、主题、工具函数
├── ar-data.js            # Data layer — demo data, replace with ar export · 数据层，用 ar export 替换
├── ar-views-core.js      # Views: Overview, Projects, per-project detail · 视图：总览、项目、项目详情
├── ar-views-more.js      # Views: Activity, Palace, Dreams, Install, Connect · 视图：活动、宫殿、梦境、安装、连接
└── README.md             # This file · 本文件
```

---

## Design System · 设计系统

<table>
<tr>
<th width="50%">🇬🇧 English</th>
<th width="50%">🇨🇳 中文</th>
</tr>
<tr>
<td>

| Token | Value |
|-------|-------|
| Background (light) | `#FAF7F0` warm parchment |
| Background (dark) | `#15120E` deep slate |
| Accent | `#8A6A3F` aged bronze |
| Display font | Baloo 2 |
| UI font | Nunito |
| Code font | JetBrains Mono |
| Heatmap levels | `--heat-0` → `--heat-4` |
| Heatmap thresholds | 1–3 / 4–9 / 10–19 / 20+ saves/day |

All colors use CSS custom properties (`--bg`, `--ink`, `--accent`, etc.) — both themes are defined in `ar-theme.css` on `[data-theme="dark"]`.

</td>
<td>

| 设计令牌 | 值 |
|-------|-------|
| 背景（亮色） | `#FAF7F0` 暖羊皮纸 |
| 背景（暗色） | `#15120E` 深板岩 |
| 强调色 | `#8A6A3F` 仿旧铜色 |
| 展示字体 | Baloo 2 |
| UI 字体 | Nunito |
| 代码字体 | JetBrains Mono |
| 热力图层级 | `--heat-0` → `--heat-4` |
| 热力图阈值 | 1–3 / 4–9 / 10–19 / 20+ 次/天 |

所有颜色使用 CSS 自定义属性（`--bg`、`--ink`、`--accent` 等）—— 两套主题均在 `ar-theme.css` 的 `[data-theme="dark"]` 中定义。

</td>
</tr>
</table>

---

<p align="center">
  Part of the <a href="https://github.com/Goldentrii/AgentRecall">AgentRecall</a> project ·
  <a href="https://github.com/Goldentrii/AgentRecall">AgentRecall</a> 项目的一部分
</p>
