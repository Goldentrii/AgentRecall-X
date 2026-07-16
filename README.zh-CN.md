[English](README.md) · **中文**

<h1 align="center">AgentRecall</h1>

<p align="center"><strong>从纠正中学习的 Claude Code 记忆。唯一衡量 agent 是否真正不再重复错误的学习闭环。</strong></p>

<p align="center">纠正账本 + 会话生命周期 + 诚实测量。MCP · SDK · CLI · Skill。</p>

<p align="center">
  <a href="https://t.me/+ywZwoHrg3AM0NDVi"><img src="https://img.shields.io/badge/Telegram-Community-2CA5E0?style=flat-square&logo=telegram" alt="Telegram Community"></a>
  <a href="https://www.npmjs.com/package/agent-recall-mcp"><img src="https://img.shields.io/npm/v/agent-recall-mcp?style=flat-square&label=MCP&color=5D34F2" alt="MCP npm"></a>
  <a href="https://www.npmjs.com/package/agent-recall-sdk"><img src="https://img.shields.io/npm/v/agent-recall-sdk?style=flat-square&label=SDK&color=0EA5E9" alt="SDK npm"></a>
  <a href="https://www.npmjs.com/package/agent-recall-cli"><img src="https://img.shields.io/npm/v/agent-recall-cli?style=flat-square&label=CLI&color=10B981" alt="CLI npm"></a>
  <a href="https://github.com/Goldentrii/AgentRecall-X/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/tools-5_default-orange?style=flat-square" alt="Tools">
  <img src="https://img.shields.io/badge/memory_layers-5-7C3AED?style=flat-square" alt="5 layers">
  <img src="https://img.shields.io/badge/cloud-zero_by_default-blue?style=flat-square" alt="Zero cloud by default">
  <img src="https://img.shields.io/badge/retrieval-keyword_%2B_RRF-8B5CF6?style=flat-square" alt="Keyword + RRF retrieval">
</p>

<p align="center">
  <a href="#会话循环"><img src="https://img.shields.io/badge/%2Farstart-OPEN·START_HERE-22C55E?style=for-the-badge" alt="/arstart"></a>
  <a href="#会话循环"><img src="https://img.shields.io/badge/%2Farsave-SAVE-FF6B6B?style=for-the-badge" alt="/arsave"></a>
  <a href="#会话循环"><img src="https://img.shields.io/badge/%2Farrecall-SEARCH-4ECDC4?style=for-the-badge" alt="/arrecall"></a>
  <a href="#会话循环"><img src="https://img.shields.io/badge/%2Farreflect-CONSOLIDATE-8B5CF6?style=for-the-badge" alt="/arreflect"></a>
</p>

<details>
<summary><b>Agent 发现了这个仓库？</b> 替你的人类安装 AgentRecall（点击展开）</summary>

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

## 它做什么

AgentRecall 是两件事：

1. **一本受治理的纠正账本** —— 每次你纠正 agent（*"不对，不是那个版本"*、*"把这一段放前面"*、*"假设之前先问我"*），这条纠正都会被存储为一条结构化记录，带严重度、证据和结果追踪。它跨会话、跨项目、跨 agent 重启持久保存。

2. **一套测量工具** —— 唯一一个跟踪纠正是否真的改变了 agent 在后续会话中行为的开源系统。每条纠正都会累积 `retrieved_count`，每次 agent 再次遇到同样情况，结果都会被记录下来（`heeded` 或 `recurred`）。

没有其他 agent 记忆工具测量第二步。这个领域里的每个 benchmark 都在测检索；没有一个测试跨会话的行为变化。我们先构建了测量工具——然后公开了我们发现的结果，包括不好看的数字。

---

## 已测量，而非空口承诺

大多数 agent 记忆工具都宣称"不会重复同样的错误"。但没有一个公布过具体数字。

以下是我们自己的测量工具在自己的真实语料库上跑出的结果（2026-07-03）：

| 指标 | 数值 | 依据文件 |
|---|---|---|
| 纠正捕获召回率（双盲审计，n=59） | **35.3%** [17.3–58.7 CI] | `UPDATE-LOG.md` §M2 |
| 遵从率，2026-07-03 之前（测量工具偏差导致的上限——不可引用） | 92.5% [Wilson 60.1–100] | `scripts/eval/baselines/rmr-baseline-2026-07-03.json` |
| 遵从率，基于证据（重置后） | **0/3** 事件 | `scripts/eval/baselines/rmr-baseline-2026-07-03.json` |
| 纠正迁移召回率（离线 bench，可达成） | **0/4** [Wilson 0–49%] | `scripts/eval/baselines/correction-transfer-real-2026-07-03.json` |
| session_start 注入中位数 | **1,489 tokens**（原为 2,010；Mem0 参照 ~7K） | `UPDATE-LOG.md` §C2 |
| session_start p95 延迟（热启动） | **363 ms**（原为 1,132） | `UPDATE-LOG.md` §C2 |

*在 2026-07-03 之前，遵从率测量工具在缺乏证据时默认判定为"已遵从"；重置后的默认值是"未知"——诚实的 0/3 是正确的起点，而不是倒退。迁移召回率在错误类别少于 39 类时无法支撑一个点估计的主张（claim-gate ledger，[benchmark spec](docs/proposals/2026-07-02-correction-transfer-benchmark-spec.md) §2.6）。*

**自行验证：** 上面每个数字都可以从已提交的 artifact 重新生成——见 [docs/eval/REPRODUCE.md](docs/eval/REPRODUCE.md)。

**这意味着什么：** 我们在自己的真实使用中捕获了 35% 的真实纠正。遵从率测量工具存在偏差，我们已重置。离线迁移 benchmark 在我们自己的语料库上得分为 0——这是一个密度问题（19 个项目里 32 条活跃纠正太稀疏，来不及提前预判错误），而不是检索架构的问题（内部实验已确认 5 次）。

学习闭环的框架是对的——这套系统本就是为了追踪纠正是否改变了行为——但目前的数据还不足以量化提升幅度。我们正在公开这套测量工具，并持续跑这个实验。

---

## 为什么它和其他记忆工具都不一样

2026 年年中，agent 记忆这个领域已经很拥挤（Mem0 约 6 万星、Graphiti/Zep 约 2.8 万星、Supermemory 约 2.8 万星、Letta 约 2.4 万星）。这个领域里大多数公开的 benchmark 数字都是在同样的 2-3 个检索 benchmark 上自我报告的，很难独立复现。

我们确认的空白（来自我们的研究报告 `docs/research/agent-memory-landscape-2026-07.md` §2）：**没有任何公开 benchmark 测量一条被捕获的纠正是否会改变一个全新 agent 在新会话中的行为。** LongMemEval、LoCoMo、MemoryAgentBench、Letta Leaderboard——测的都是检索或会话内更新。

AgentRecall 占据了这块无人认领的地盘中的两部分：

- **纠正账本** —— 一个受治理的数据模型（`corrections-export/v1`，脱敏出口、可撤回、严重度、证明置信度），任何引擎都可以对接它。
- **测量工具** —— `predict-loo`（留一法、反自我确认、双分母）以及纠正迁移 benchmark 规范（`HeedBench v1`——暂定名），它们实现了缺失的那条流水线：捕获 → 持久化 → 新会话 → 测量复发。

Agent 记忆领域的 benchmark 数字通常是自我报告、难以复现的。而我们的数字可以用一条命令（`npm run bench`）从一个固定的、哈希锁定的语料库重新生成——包括那些让我们看起来不太好看的分数。

---

## 快速开始

> **可视化安装指南 — 13 个客户端，一键复制提示词：** 用浏览器打开仓库中的 [`warroom/install.html`](warroom/install.html)（或解压 War Room 发布包后打开）。无需服务器。

<p align="center">
  <img src="warroom/static/install-preview.png" alt="AgentRecall 安装指南" width="900">
</p>

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
  https://raw.githubusercontent.com/Goldentrii/AgentRecall-X/main/SKILL.md
```

### SDK 和 CLI

```bash
npm install agent-recall-sdk        # JS/TS apps
npx agent-recall-cli recall "topic" # terminal & CI
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
| 5 | **Correction 纠正** | 行为校准：agent 必须遵守的规则，并配合严重度与结果追踪。 | `corrections/` |
| + | **Awareness 感知** | 跨项目 insight，由确认 N 次以上的纠正晋升而来——复合层。 | `palace/awareness` |

所有层共享同一套规范命名语法，让任何 agent 都能根据意图组合出检索路径。已有文件通过 `legacy_path` 视图继续可用——无需迁移。

---

## 会话循环

```mermaid
flowchart LR
    A([会话开始]) --> B["/arstart — 打开<br/>看板 → 选择 → 加载上下文"]
    B --> C{工作}
    C -->|需要过去的知识| D["/arrecall — 搜索"]
    D --> C
    C --> E["/arsave — 保存<br/>写 journal + 复合"]
    E --> F([会话结束])
    F -. 每 K 次会话 .-> G["/arreflect — 整合"]
    G -.-> A
```

| 命令 | 什么时候 | 做什么 |
|---|---|---|
| `/arstart` | **每个会话最先** | OPEN（打开）。不带参数 = 所有项目的状态看板（待办、阻塞）→ 按编号选 → 加载该项目的深度上下文（palace 房间、纠正记录、任务相关召回）。`/arstart <slug>` 直接加载；`/arstart bootstrap` 扫描你的机器并导入已有项目。 |
| `/arsave` | **每个会话最后** | SAVE（保存）。写 journal + palace 合并 + awareness 复合。`/arsave all` 批量保存当天所有并行会话（扫描、合并、去重）。 |
| `/arrecall` | 会话中，按需 | SEARCH（搜索）。为当前任务浮现过去的知识——已记录的修复方案、历史决策、模式。 |
| `/arreflect` | 每 K 次会话 | CONSOLIDATE（整合）。周期性 triage：确认复发/幻影匹配，聚类新的错误类别，提出规则再抽象建议（规则修改仍由 owner 把关）。 |

> **没有 `/arstart`，新 agent 完全失去方向。没有 `/arsave`，什么都不会复合。这两个是主干；`/arrecall` 和 `/arreflect` 让它持续复合。**

---

## 自动化原则

记忆只有在自动触发时才会复合，而不是按需调用。在数周的真实使用中，每一个拉取型工具（`recall`、`memory_query`）在 44 个项目里都是零次自然调用——包括构建它们的 agent 本身也不例外。这就是为什么默认只发布 5 个工具：双动词模型（session_start / session_end）承载了全部的复合价值，其余功能都是通过 `--full` 按需开启的可选项。

---

## Dreaming —— 夜间自动整合（可选）

一个自主的隔夜 agent，趁你睡觉时把当天所有会话写入的内容复合在一起。

| 做什么 | 结果 |
|---|---|
| 跨项目挖掘模式 | 重复纠正晋升至 `palace/awareness` |
| Ebbinghaus 显著性衰减 | 低价值房间自然消退；palace 保持精炼 |
| Journal 汇总 | 30 天以上的条目压缩为摘要房间 |
| Awareness 毕业 | 被确认 N 次的纠正跨项目晋升 |
| Telegram 报告 | 夜间摘要：学到了什么 · 衰减了什么 · 结晶了什么 |

**需要有效的 Claude Code 登录。** 如果会话过期，dream 会跳过并通过 Telegram 发送提醒。

```bash
# Fix expired login (run this when dreaming stops)
claude login
```

Dream 报告保存在本地 `~/.agent-recall/dreams/YYYY-MM-DD.md`。

---

## 实验性：复发与反思 Harness 工具包

**这一节回答的问题是：一条纠正是否真的改变了行为，还是同样的错误又回来了？** 一条已记录的纠正，如果它所属的错误类别在规则写入之后又复发了，就是一次*幻影梯度步（phantom gradient step）*——写入成本已经付出，行为却从未改变。

[`experimental/harness-kit/`](experimental/harness-kit/) 里的这套工具是一层构建在 AgentRecall 之上的 Claude Code harness，用来闭合这个循环：

| 组件 | 做什么 |
|---|---|
| `ar-scoreboard.py`（SessionStart hook） | 每次会话的健康摘要：纠正流转、insight 晋升率、闭环健康度、幻影计数、反思周期 |
| `ar-recurrence-check.py`（+ 你的 `~/.agent-recall/taxonomy.json`，schema 见 `TAXONOMY-SCHEMA.md`） | 对你的纠正做错误类别分类；机械式幻影检测（违规日期晚于其规则日期） |
| `/arstart` · `/arsave` · `/arrecall` · `/arreflect` | 四个记忆动词（打开 · 保存 · 搜索 · 整合）对应的 slash command |
| `/arreflect`（每 K 次会话） | 周期性 triage：确认待定匹配，聚类新的错误类别，提出规则再抽象建议——**规则修改仍由 owner 把关** |
| `ar-nudge.py`（UserPromptSubmit hook） | 在会话中途提醒逾期未做的反思——把记忆推到行动发生的那一刻，而不是等着被想起来 |
| `dispatch-model-guard.py`（PreToolUse hook，可选） | 针对显式 model 派发策略的仅警告型守卫——把一条文字说明无法强制执行的规则机制化的一个例子 |

North-star 指标：被处理的错误类别的**再抽象后幻影率 → 0**。首次验证跑（2026-07-14，一个重度用户的 harness）：在 109 条纠正中发现 8 个错误类别、18 个被确认的幻影梯度步；当天再抽象了 6 条规则。

**状态：实验性。** 目前只在一个 harness 上验证过；仅依赖 Python 3 标准库；安装步骤和注意事项见工具包的 [README](experimental/harness-kit/README.md)。自 v3.4.37 起，同样的现象也已被原生测量：`failure_class` + 跨项目复发关联。

---

## War Room 仪表盘 —— 下载并部署

一个**本地优先的可视化仪表盘**，展示你的记忆：活动日历、各项目状态、纠正记录、insight——全部从你本地的 `~/.agent-recall/` 数据渲染。完全离线（资源已内置），无需 Node、无需构建步骤。

<p align="center">
  <img src="warroom/static/preview.png" alt="AgentRecall War Room — 总览" width="900">
</p>

1. 从 [最新 GitHub Release](https://github.com/Goldentrii/AgentRecall-X/releases/latest) 下载 **`ar-warroom-v3.4.32.zip`**。
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

检索方式：关键词 + RRF（Cormack 2009）。FSRS-lite 衰减（Ebbinghaus → SuperMemo → FSRS-6）。代码库中包含一个 Modern Hopfield 重排序原语（Ramsauer 2020），但**未**接入默认路径——目前实际运行的是 BM25/关键词 + RRF，再加上设置了 `OPENAI_API_KEY` 时可选启用的向量检索。

## 平台兼容

| 平台 | 机制 | 状态 |
|---|---|---|
| Claude Code | MCP server + skill + hooks | 主要 |
| Cursor · Windsurf · VS Code (Copilot) · Codex | MCP server | 支持 |
| 任意 JS/TS 应用 | SDK (`agent-recall-sdk`) | 支持 |
| 终端 / CI | CLI (`ar`) | 支持 |

---

## 链接

- **完整参考** → [README.full.md](README.full.md)
- **文档** → [docs/](docs/) —— 命令参考、架构深入解析
- **更新日志** → [UPDATE-LOG.md](UPDATE-LOG.md) —— 逐阶段演进 + 设计推理
- **Benchmark 规范** → [docs/proposals/2026-07-02-correction-transfer-benchmark-spec.md](docs/proposals/2026-07-02-correction-transfer-benchmark-spec.md)
- **领域研究报告** → [docs/research/agent-memory-landscape-2026-07.md](docs/research/agent-memory-landscape-2026-07.md)
- **Skill** → [SKILL.md](SKILL.md) —— Claude Code skill 定义
- **社区** → [Telegram](https://t.me/+ywZwoHrg3AM0NDVi) · [GitHub Issues](https://github.com/Goldentrii/AgentRecall-X/issues)

## 贡献

欢迎 PR。任何实质性改动请先开 issue——这个设计有自己的主张，且基于已发表的研究；我们希望改动也能用同样的方式落地。

## License

MIT —— 见 [LICENSE](LICENSE)。
