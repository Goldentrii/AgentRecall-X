[English](README.md) · **中文**

<h1 align="center">AgentRecall</h1>

<p align="center"><strong>你的 agent 不只是记得。它在学你怎么想。</strong></p>
<p align="center">每一次纠正都是不会重复的错误。每一次复合都是不会重建的上下文。</p>
<p align="center">持久、可复合的记忆 + 自动纠正捕获。MCP server + SDK + CLI。</p>

<p align="center">
  <a href="https://t.me/+ywZwoHrg3AM0NDVi"><img src="https://img.shields.io/badge/Telegram-Community-2CA5E0?style=flat-square&logo=telegram" alt="Telegram Community"></a>
  <a href="https://www.npmjs.com/package/agent-recall-mcp"><img src="https://img.shields.io/npm/v/agent-recall-mcp?style=flat-square&label=MCP&color=5D34F2" alt="MCP npm"></a>
  <a href="https://www.npmjs.com/package/agent-recall-sdk"><img src="https://img.shields.io/npm/v/agent-recall-sdk?style=flat-square&label=SDK&color=0EA5E9" alt="SDK npm"></a>
  <a href="https://www.npmjs.com/package/agent-recall-cli"><img src="https://img.shields.io/npm/v/agent-recall-cli?style=flat-square&label=CLI&color=10B981" alt="CLI npm"></a>
  <a href="https://github.com/Goldentrii/AgentRecall/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/MCP-5_tools_default-orange?style=flat-square" alt="Tools">
  <img src="https://img.shields.io/badge/memory_layers-5-7C3AED?style=flat-square" alt="5 layers">
  <img src="https://img.shields.io/badge/cloud-zero-blue?style=flat-square" alt="Zero Cloud">
  <img src="https://img.shields.io/badge/decay-FSRS--lite-3B82F6?style=flat-square" alt="FSRS-lite decay">
  <img src="https://img.shields.io/badge/retrieval-Hopfield_%2B_RRF-8B5CF6?style=flat-square" alt="Hopfield retrieval">
  <img src="https://img.shields.io/badge/feedback-precision_KPI-F59E0B?style=flat-square" alt="Precision KPI">
</p>

<p align="center">
  <a href="#会话循环"><img src="https://img.shields.io/badge/%2Farstatus-START_HERE-22C55E?style=for-the-badge" alt="/arstatus"></a>
  <a href="#会话循环"><img src="https://img.shields.io/badge/%2Farstart-Load_Context-4ECDC4?style=for-the-badge" alt="/arstart"></a>
  <a href="#会话循环"><img src="https://img.shields.io/badge/%2Farsave-Save_Session-FF6B6B?style=for-the-badge" alt="/arsave"></a>
  <a href="#会话循环"><img src="https://img.shields.io/badge/%2Farsaveall-Batch_Save-FFD93D?style=for-the-badge" alt="/arsaveall"></a>
  <a href="#会话循环"><img src="https://img.shields.io/badge/%2Farbootstrap-Transfer_Memory-8B5CF6?style=for-the-badge" alt="/arbootstrap"></a>
</p>

<details>
<summary>🤖 <b>Agent 发现了这个仓库？</b> 替你的人类安装 AgentRecall（点击展开）</summary>

**1. 安装 MCP server**（Claude Code）：

```bash
claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp
```

其他客户端的通用 MCP JSON：

```json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }
```

**2. 每个新会话的第一条消息**，跑这个闭环：

```
At the start of a session, call session_start to load context.
When the human corrects you, call remember with type "correction".
At the end of a session, call session_end to compound what you learned.
```

</details>

---

## 什么和为什么

**AgentRecall 不是记忆工具，是学习闭环。** 记忆是机制，理解才是目标。每一次纠正——*"不是那个版本"*、*"先放这一段"*、*"假设之前先问我"*——都会被存储、加权、并在下次召回。跑 10 次会话之后，agent 不只是记得项目，它理解你的思考方式。

- **以纠正为先。** 你说"不对"时，我们记下 `CorrectionRecord`（严重度、归属、证据）。跨会话被确认 N 次后，自动晋升为跨项目的 insight。
- **可量化的学习闭环。** 每条纠正都跟踪 `retrieved_count`、`heeded_count`、`recurrence_count`、`precision`。唯一重要的 KPI：警告之后同样的 bug 还复发吗？
- **五种记忆类型。** Episodic、semantic、procedural、narrative、correction —— 对应认知心理学经典分类（Squire 2004、Tulving 1972）。
- **只用本地 markdown。** 一切都在 `~/.agent-recall/`。用 Obsidian 打开、用终端 grep、用 git 版本管理。零云、零 API key、零锁定。
- **基于已发表数学。** FSRS-lite 衰减（Ebbinghaus → SuperMemo → FSRS-6）、Modern Hopfield 检索（Ramsauer 2020）、RRF 融合（Cormack 2009）。

> **自动化定律（The Automaticity Law）。** 记忆只有在被*自动*使用时才会复合，而不是按需调用。基于真实语料库测量：推送通道（`session_start`、`session_end`、纠正 hooks）有持续的行为改变使用记录；而拉取通道在 44 个项目、数周真实使用中有**零**次有机调用——包括构建它们的 agent 本身。这就是为什么默认只发布 5 个工具：双动词模型（吸入/呼出）承载了所有复合价值，其余功能通过 `--full` 按需开启。

> **注入精度 KPI（Injection Precision KPI）。** 每条纠正跟踪 `precision = heeded / retrieved`——在我们浮现这条警告的所有次数里，agent 真正照做了多少次？`precision < 0.3` → archive 候选（应该停止注入的噪声）。`precision ≥ 0.8` → 加速晋升（高信号，更早复合）。这就是可量化的主张：一个你能证明它在起作用的记忆系统。

---

## 快速开始

### MCP Server —— 给 AI agent

```bash
# Claude Code
claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp

# Cursor — .cursor/mcp.json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }

# VS Code — .vscode/mcp.json
{ "servers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }

# Windsurf — ~/.codeium/windsurf/mcp_config.json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }

# Codex
codex mcp add agent-recall -- npx -y agent-recall-mcp
```

**Skill（仅 Claude Code）：**

```bash
mkdir -p ~/.claude/skills/agent-recall
curl -o ~/.claude/skills/agent-recall/SKILL.md \
  https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/SKILL.md
```

### SDK 和 CLI

```bash
npm install agent-recall-sdk        # JS/TS 应用
npx agent-recall-cli recall "topic" # 终端和 CI
```

```typescript
import { AgentRecall } from "agent-recall-sdk";
const memory = new AgentRecall({ project: "my-app" });
await memory.capture("What stack?", "Next.js + Postgres");
const ctx = await memory.recall("rate limiting");
```

---

## 五层记忆模型

把认知心理学的经典记忆分类映射到你的 agent 的文件系统：

| 层 | 类型 | 存什么 | 路径 |
|---|---|---|---|
| 1 | **Episodic 情景** | 每次会话发生了什么，按时间顺序。工作时自动写入。 | `journal/` |
| 2 | **Semantic 语义** | 按主题聚类的事实，带 `[[wikilinks]]`：架构、目标、阻塞。 | `palace/rooms/` |
| 3 | **Procedural 程序** | IF-THEN 产生式规则——可复用的操作流程。 | `palace/skills/` |
| 4 | **Narrative 叙事** | 项目阶段：目标 → 难点 → 怎么解决 → 提炼。 | `palace/pipeline/` |
| 5 | **Correction 纠正** | 行为校准：agent 必须遵守的规则，配合 precision KPI。 | `corrections/` |
| + | **Awareness 感知** | 跨项目 insight，由确认 N 次以上的纠正晋升而来——复合层。 | `palace/awareness` |

所有层共享一个**规范命名语法**（`<scope>/<type>/[<topic>/]<temporal>--<slug>.md`），任何 agent 都能用意图组合检索路径。旧文件通过 `legacy_path` 视图继续可用——无需迁移。

---

## 会话循环

| 命令 | 什么时候 | 做什么 |
|---|---|---|
| 🔴 `/arstatus` | **每个会话最先** | 所有项目的状态看板：待办、阻塞、相关性分数。按编号选。 |
| `/arstart` | 选完项目后 | 加载深度上下文：palace 房间、纠正记录、任务相关召回。 |
| 🔴 `/arsave` | **每个会话最后** | 写 journal + palace 合并 + awareness 复合 + 语义预取。 |
| `/arsaveall` | 一天结束（多会话） | 批量保存所有并行会话——扫描、合并、去重、完成。 |
| `/arbootstrap` | 首次安装 / 迁移 | 扫描你的机器，把已有项目导入进来。 |

> **没有 `/arstatus`，新 agent 完全失去方向。没有 `/arsave`，什么都不会复合。这两个就是整个闭环。**

---

## 🖥️ War Room 仪表盘 —— 下载并部署

一个**本地优先的可视化仪表盘**，展示你的记忆：活动日历、各项目状态、纠正记录、insight——全部从你本地的 `~/.agent-recall/` 数据渲染。完全离线（资源已内置），无需 Node、无需构建步骤。

<p align="center">
  <img src="warroom/static/preview.png" alt="AgentRecall War Room — 总览" width="900">
</p>

1. 从 [最新 GitHub Release](https://github.com/Goldentrii/AgentRecall/releases/latest) 下载 **`ar-warroom-v3.4.30.zip`**。
2. 解压后本地启动：

```bash
cd warroom
python3 -m http.server 8080
```

3. 打开 **http://localhost:8080/AgentRecall.html**

对于 **Hermes / OpenClaw / OpenCode** 用户，这也是推荐的上手方式——一个离线页面就能看到 agent 学到的一切。

---

## 架构

TypeScript monorepo，4 个发布包：`core`（存储 + 工具逻辑）、`mcp-server`（轻量 MCP 包装）、`sdk`（编程 API）、`cli`（`ar` 命令）。所有记忆都是 `~/.agent-recall/projects/<slug>/` 下的本地 markdown——`journal/`、`corrections/` 和 `palace/`（rooms、skills、pipeline、awareness）。可选的 Supabase 镜像可加上 pgvector 语义召回；纯本地仍是默认。

## 平台兼容

| 平台 | 机制 | 状态 |
|---|---|---|
| Claude Code | MCP server + skill + hooks | ✅ 主要 |
| Cursor · Windsurf · VS Code (Copilot) · Codex | MCP server | ✅ |
| 任意 JS/TS 应用 | SDK (`agent-recall-sdk`) | ✅ |
| 终端 / CI | CLI (`ar`) | ✅ |

---

## 链接

- **完整参考** → [README.full.md](README.full.md)
- **文档** → [docs/](docs/) —— 命令参考、架构深入
- **更新日志** → [UPDATE-LOG.md](UPDATE-LOG.md) —— 逐阶段演进 + 设计推理
- **基准报告** → [REPORT-2026-05-30.html](REPORT-2026-05-30.html) —— Phase 6 可视化报告
- **Skill** → [SKILL.md](SKILL.md) —— Claude Code skill 定义
- **社区** → [Telegram](https://t.me/+ywZwoHrg3AM0NDVi) · [GitHub Issues](https://github.com/Goldentrii/AgentRecall/issues)

## 贡献

欢迎 PR。任何实质性改动请先开 issue——这个设计有自己的主张，且基于已发表的研究；我们希望改动也能用同样的方式落地。

## License

MIT —— 见 [LICENSE](LICENSE)。
