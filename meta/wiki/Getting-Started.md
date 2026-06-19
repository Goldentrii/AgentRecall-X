# Getting Started | 快速开始

Get AgentRecall running in 5 minutes. Pick your integration method and follow the steps.

5 分钟内让 AgentRecall 运行起来。选择你的集成方式，按步骤操作。

---

## Step 1: Install | 第一步：安装

### MCP Server (for AI agents | 适用于 AI agent)

Choose your editor:

选择你的编辑器：

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

### Optional: Install `/arsave` and `/arstart` commands (Claude Code only)

可选：安装 `/arsave` 和 `/arstart` 命令（仅限 Claude Code）

```bash
mkdir -p ~/.claude/commands
curl -o ~/.claude/commands/arsave.md \
  https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arsave.md
curl -o ~/.claude/commands/arstart.md \
  https://raw.githubusercontent.com/Goldentrii/AgentRecall/main/commands/arstart.md
```

### SDK (for JS/TS applications | 适用于 JS/TS 应用)

```bash
npm install agent-recall-sdk
```

### CLI (for terminal | 适用于终端)

```bash
npm install -g agent-recall-cli
```

---

## Step 2: First Session | 第二步：第一次使用

### Start a session | 开始一个会话

In Claude Code (or any MCP-compatible agent), type:

在 Claude Code（或任何兼容 MCP 的 agent）中，输入：

```
/arstart
```

The agent will:
1. Ask what you're working on (or detect it from context)
2. Call `recall_insight` — surface relevant cross-project insights
3. Call `palace_walk` — load project context (~200 tokens)
4. Show a cold-start brief

Agent 会：
1. 询问你在做什么（或从上下文中检测）
2. 调用 `recall_insight` —— 浮现相关的跨项目洞察
3. 调用 `palace_walk` —— 加载项目上下文（约 200 tokens）
4. 显示冷启动摘要

> First time? The palace will be empty. That's normal — it builds up over sessions.
>
> 第一次使用？记忆宫殿会是空的。这是正常的——它会随着会话逐渐积累。

### Work normally | 正常工作

Just work as usual. During the session, the agent may use:

正常工作即可。在会话期间，agent 可能会使用：

- `journal_capture` — record key Q&A pairs / 记录关键问答对
- `alignment_check` — measure understanding gap / 测量理解鸿沟
- `palace_write` — save important decisions / 保存重要决策

### Save at the end | 结束时保存

```
/arsave
```

The agent will:
1. Write a journal entry (what was done, decisions, blockers)
2. Consolidate decisions into palace rooms
3. Extract 1-3 insights into the awareness system
4. Optionally push to git

Agent 会：
1. 写日志条目（完成了什么、决策、阻塞项）
2. 将决策整合到记忆宫殿的房间中
3. 提取 1-3 条洞察到感知系统
4. 可选地推送到 git

---

## Step 3: Second Session (where the magic happens) | 第三步：第二次会话（魔法发生的地方）

Next day, new session, maybe even a different agent instance:

第二天，新会话，甚至可能是不同的 agent 实例：

```
/arstart
```

This time, the cold start loads:
- Yesterday's decisions from the palace
- Relevant insights from the awareness system
- Your project's current trajectory

这次，冷启动会加载：
- 昨天在记忆宫殿中的决策
- 感知系统中的相关洞察
- 你项目当前的方向

**No re-explaining needed.** The agent picks up where you left off.

**不需要重新解释。** Agent 从你上次停止的地方继续。

---

## What's Stored Where | 存储在哪里

All data is local markdown files. No cloud, no API keys.

所有数据都是本地 markdown 文件。没有云服务，没有 API key。

```
~/.agent-recall/
├── projects/
│   └── <project-name>/
│       ├── journal/           # Daily logs / 每日日志
│       │   ├── 2026-04-10.md
│       │   └── ...
│       ├── palace/            # Memory rooms / 记忆房间
│       │   ├── architecture/
│       │   ├── goals/
│       │   └── blockers/
│       └── awareness.md       # Compounding insights / 复合洞察
└── insights/
    └── index.md               # Cross-project insights / 跨项目洞察
```

Browse in Obsidian, grep in terminal, version in git. See [[Obsidian Integration]] and [[Git Sync]].

在 Obsidian 中浏览，在终端中 grep，在 git 中版本管理。参见 [[Obsidian 集成]] 和 [[Git 同步]]。

---

## Next Steps | 下一步

- [[When to Use]] — know when AgentRecall adds value vs. when to skip / 了解何时 AgentRecall 有价值，何时跳过
- [[Core Concepts]] — understand the memory pyramid and how layers interact / 理解记忆金字塔和各层如何交互
- [[MCP Tools Reference]] — all 22 tools explained / 全部 22 个工具详解
