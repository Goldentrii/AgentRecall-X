# FAQ | 常见问题

---

## General | 一般问题

### Is my data sent to the cloud? | 我的数据会发送到云端吗？

**No.** Everything is stored as local markdown files in `~/.agent-recall/`. Zero cloud, zero telemetry, zero API keys. Browse your data in Obsidian, grep it in the terminal, version it with git.

**不会。** 所有数据都以本地 markdown 文件存储在 `~/.agent-recall/` 中。零云服务、零遥测、零 API key。在 Obsidian 中浏览，在终端中 grep，用 git 版本管理。

### Which editors/agents are supported? | 支持哪些编辑器/agent？

Any MCP-compatible agent: Claude Code, Cursor, VS Code (Copilot), Windsurf, Codex. Plus SDK for any JS/TS framework (LangChain, CrewAI, Vercel AI SDK) and CLI for terminal workflows.

任何兼容 MCP 的 agent：Claude Code、Cursor、VS Code (Copilot)、Windsurf、Codex。另外 SDK 支持任何 JS/TS 框架（LangChain、CrewAI、Vercel AI SDK），CLI 支持终端工作流。

### Do I need all 22 tools? | 我需要全部 22 个工具吗？

**No.** Start with 5: `recall_insight`, `palace_walk`, `journal_capture`, `alignment_check`, `awareness_update`. These cover 90% of daily use. See [[MCP Tools Reference]] for the priority guide.

**不需要。** 从 5 个开始：`recall_insight`、`palace_walk`、`journal_capture`、`alignment_check`、`awareness_update`。覆盖 90% 的日常使用。参见 [[MCP 工具参考]] 的优先级指南。

---

## Usage | 使用问题

### When should I NOT use AgentRecall? | 什么时候不应该使用 AgentRecall？

Skip it for truly throwaway single-session tasks: quick Q&A, trivial one-off scripts, simple fixes. For everything else, use it — memory compounds over time. See [[When to Use]] for the full decision guide.

对于真正一次性的单会话任务跳过它：快速问答、简单的一次性脚本、简单修复。其他情况都使用——记忆随时间复利。完整决策指南参见 [[何时使用]]。

### My palace is empty on first use — is that normal? | 第一次使用时记忆宫殿是空的，正常吗？

**Yes.** The palace builds up over sessions. After your first `/arsave`, you'll have journal entries and initial palace rooms. After 3-5 sessions, the awareness system starts compounding insights.

**是的。** 记忆宫殿随会话逐渐积累。第一次 `/arsave` 后，你会有日志条目和初始宫殿房间。3-5 次会话后，感知系统开始复利洞察。

### How much token overhead does AgentRecall add? | AgentRecall 增加多少 token 开销？

Measured on a simple CLI task: ~2,300 tokens (~30% overhead) per session from MCP tool calls. For simple single-session tasks, this is pure overhead. For multi-session projects, the cold-start recall saves far more than it costs. Break-even point: ~3 sessions.

在简单 CLI 任务上测量：每次会话来自 MCP 工具调用约 2,300 tokens（约 30% 开销）。对于简单的单会话任务，这是纯开销。对于多会话项目，冷启动回忆节省的远超成本。盈亏平衡点：约 3 次会话。

### Can multiple agents share the same memory? | 多个 agent 可以共享同一个记忆吗？

**Yes.** Memory is file-based. Any agent pointing to the same `~/.agent-recall/` directory reads the same data. This is how `/arstart` works — a fresh agent instance loads yesterday's decisions written by a different agent.

**可以。** 记忆基于文件。任何指向相同 `~/.agent-recall/` 目录的 agent 读取相同数据。这就是 `/arstart` 的工作方式——一个新的 agent 实例加载昨天由不同 agent 写入的决策。

---

## Troubleshooting | 故障排查

### `recall_insight` returns no matches | `recall_insight` 没有返回匹配

This means no stored insight matches your current task context. This is normal for new projects or when working in a new domain. Insights build up over time through `awareness_update`.

这意味着没有存储的洞察匹配你当前的任务上下文。这对于新项目或在新领域工作时是正常的。洞察通过 `awareness_update` 随时间积累。

### `palace_walk` returns minimal content | `palace_walk` 返回内容很少

Check the depth parameter:
- `identity` returns ~50 tokens (just the project name)
- `active` returns ~200 tokens (top rooms)
- Use `relevant` with a `focus` parameter for targeted loading
- Use `full` only when you need everything

检查 depth 参数：
- `identity` 返回约 50 tokens（只有项目名）
- `active` 返回约 200 tokens（顶部房间）
- 使用 `relevant` 加 `focus` 参数进行定向加载
- 只在需要全部内容时使用 `full`

### Journals are getting too large | 日志变得太大

Use `journal_rollup` to condense old journals into weekly summaries:

使用 `journal_rollup` 将旧日志压缩为周报摘要：

```bash
# Preview what would be rolled up
ar rollup --dry-run

# Roll up entries older than 14 days
ar rollup --min-age-days 14
```

### The awareness file is full (200 lines) | 感知文件已满（200 行）

**This is by design.** The 200-line cap forces merge-or-replace. When a new insight is added, it either merges with an existing one (strengthening it) or replaces the lowest-salience insight. This is what makes memory compound instead of accumulate.

**这是设计如此。** 200 行上限强制合并或替换。当添加新洞察时，它要么与现有的合并（强化它），要么替换最低显著性的洞察。这就是让记忆复利而不是线性累积的机制。

---

## Migration | 迁移

### How do I upgrade from v2 to v3? | 如何从 v2 升级到 v3？

See the [[Migration Guide]] for breaking changes and upgrade steps.

破坏性变更和升级步骤参见 [[迁移指南]]。

---

## See Also | 参见

- [[Getting Started]] — install and first session / 安装和第一次使用
- [[When to Use]] — decision guide / 决策指南
- [[MCP Tools Reference]] — all tools explained / 全部工具详解
