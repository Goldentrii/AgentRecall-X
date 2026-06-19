# MCP Tools Reference | MCP 工具参考

AgentRecall exposes 22 MCP tools. **You don't need all 22.** Start with the 5-tool starter set, add more as needed.

AgentRecall 暴露了 22 个 MCP 工具。**你不需要全部 22 个。** 从 5 个核心工具开始，按需添加。

---

## Priority Guide | 优先级指南

### Tier 1: Start Here (daily use) | 第一梯队：从这里开始（日常使用）

These 5 tools cover 90% of daily usage:

这 5 个工具覆盖 90% 的日常使用：

| Tool | When | What it does |
|------|------|-------------|
| `recall_insight` | Session start | Surface cross-project lessons that match your current task / 浮现匹配当前任务的跨项目经验 |
| `palace_walk` | Session start | Load project context progressively (50-2000 tokens) / 渐进式加载项目上下文 |
| `journal_capture` | During work | Record a key Q&A pair / 记录关键问答对 |
| `alignment_check` | Before big tasks | Measure understanding gap before starting / 开始前测量理解鸿沟 |
| `awareness_update` | Session end | Extract 1-3 compounding insights / 提取 1-3 条复利洞察 |

### Tier 2: When Needed | 第二梯队：按需使用

| Tool | When | What it does |
|------|------|-------------|
| `palace_write` | Important decisions | Save structured knowledge to a room / 将结构化知识保存到房间 |
| `journal_write` | Session end | Write full daily journal entry / 写完整的每日日志 |
| `context_synthesize` | Session end | Promote journal content into palace rooms / 将日志内容提升到记忆宫殿 |
| `palace_read` | Need specific context | Read a palace room's content / 读取记忆宫殿房间内容 |
| `journal_read` | Resuming work | Read a specific day's journal / 读取特定日期的日志 |

### Tier 3: Maintenance & Advanced | 第三梯队：维护与高级

| Tool | When | What it does |
|------|------|-------------|
| `journal_rollup` | Weekly | Condense old journals into weekly summaries / 将旧日志压缩为周报 |
| `palace_lint` | Monthly | Health check: stale, orphan, low-salience rooms / 健康检查：过时的、孤立的、低显著性的房间 |
| `palace_search` | Looking for something | Search across all rooms / 跨所有房间搜索 |
| `journal_search` | Looking for something | Search across all journals / 跨所有日志搜索 |
| `nudge` | Contradiction detected | Flag contradiction between current and past input / 标记当前输入和过去输入的矛盾 |
| `knowledge_write` | Permanent lessons | Write permanent lesson with auto-categorization / 写永久经验并自动分类 |
| `knowledge_read` | Recalling lessons | Read lessons by project/category / 按项目/类别读取经验 |
| `journal_list` | Browsing history | List recent journal entries / 列出最近的日志条目 |
| `journal_projects` | Multi-project | List all tracked projects / 列出所有跟踪的项目 |
| `journal_state` | Agent handoff | JSON state for agent-to-agent handoffs / Agent 间交接的 JSON 状态 |
| `journal_cold_start` | Alternative start | Palace-first cold start / 以记忆宫殿为首的冷启动 |
| `journal_archive` | Cleanup | Archive old entries to cold storage / 将旧条目归档到冷存储 |

---

## Detailed Reference | 详细参考

### Memory Palace Tools | 记忆宫殿工具

#### `palace_walk`

Progressive context loading for cold start. Start light, deepen as needed.

冷启动的渐进式上下文加载。轻量开始，按需深入。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `depth` | `"identity" \| "active" \| "relevant" \| "full"` | `"active"` | How deep to walk / 走多深 |
| `focus` | `string` | — | For "relevant" depth: focus query / 用于 "relevant" 深度的焦点查询 |
| `project` | `string` | auto | Project slug / 项目标识 |

```
Depth tokens:
  identity  ~50    → project name + purpose
  active    ~200   → top rooms + awareness
  relevant  ~500   → rooms matching focus query
  full      ~2000  → everything
```

**Example / 示例:**
```json
{ "depth": "relevant", "focus": "authentication" }
```

---

#### `palace_write`

Write memory to a room. Triggers fan-out: cross-references update in connected rooms.

向房间写入记忆。触发扇出：交叉引用在连接的房间中更新。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `room` | `string` | required | Room slug (e.g., "architecture") / 房间标识 |
| `content` | `string` | required | Markdown content. Use `[[room/topic]]` for cross-refs / Markdown 内容，使用 `[[room/topic]]` 交叉引用 |
| `topic` | `string` | — | Topic file within the room / 房间内的主题文件 |
| `importance` | `"high" \| "medium" \| "low"` | `"medium"` | Memory importance for salience scoring / 显著性评分的重要性 |
| `connections` | `string[]` | — | Explicit room connections / 显式房间连接 |

**Example / 示例:**
```json
{
  "room": "architecture",
  "topic": "database",
  "content": "Switched from REST to tRPC. See [[goals/q2-migration]] for context.",
  "importance": "high"
}
```

---

#### `palace_read`

Read a specific room or list all rooms.

读取特定房间或列出所有房间。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `room` | `string` | — | Room to read (omit to list all) / 要读取的房间（省略则列出全部） |
| `topic` | `string` | — | Specific topic within room / 房间内的特定主题 |

---

#### `palace_search`

Search across all rooms, results ranked by salience.

跨所有房间搜索，结果按显著性排序。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | required | Search query / 搜索查询 |
| `room` | `string` | — | Limit to a specific room / 限制在特定房间内 |

---

#### `palace_lint`

Health check for the memory palace.

记忆宫殿的健康检查。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `fix` | `boolean` | `false` | Auto-archive stale/orphan rooms / 自动归档过时/孤立房间 |

---

### Awareness & Insight Tools | 感知与洞察工具

#### `recall_insight`

Before starting work, surface cross-project insights that match the current task.

开始工作前，浮现匹配当前任务的跨项目洞察。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `context` | `string` | required | Current task description (1-2 sentences) / 当前任务描述 |
| `include_awareness` | `boolean` | `true` | Also return awareness summary / 同时返回感知摘要 |
| `limit` | `number` | `5` | Max insights to return / 最多返回洞察数 |

---

#### `awareness_update`

Add insights to the compounding awareness system. Call at end of session.

将洞察添加到复利感知系统。在会话结束时调用。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `insights` | `array` | required | 1-5 insights, each with: title, evidence, applies_when, source, severity / 1-5 条洞察 |
| `trajectory` | `string` | — | Where is the work heading? / 工作方向？ |
| `blind_spots` | `string[]` | — | What hasn't been explored? / 什么还没探索？ |

**Insight format / 洞察格式:**
```json
{
  "title": "Rate limiting prevents runaway costs",
  "evidence": "API costs spiked 10x without limits in Project A",
  "applies_when": ["api", "proxy", "rate-limit", "cost"],
  "source": "Project A, 2026-04-01",
  "severity": "critical"
}
```

---

### Alignment Tools | 对齐工具

#### `alignment_check`

Measure the Intelligent Distance gap before starting work.

在开始工作前测量智能距离鸿沟。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `goal` | `string` | required | Agent's understanding of the goal / Agent 对目标的理解 |
| `confidence` | `"high" \| "medium" \| "low"` | required | Agent's confidence level / Agent 的信心水平 |
| `assumptions` | `string[]` | — | What agent assumed / Agent 的假设 |
| `category` | `"goal" \| "scope" \| "priority" \| "technical" \| "aesthetic"` | `"goal"` | Gap type / 鸿沟类型 |
| `unclear` | `string` | — | What agent is unsure about / Agent 不确定的内容 |
| `human_correction` | `string` | — | Human's correction or "confirmed" / 人类的纠正或"已确认" |
| `delta` | `string` | — | The gap description, or "none" / 鸿沟描述 |

---

#### `nudge`

Detect and flag contradiction between current and past input.

检测并标记当前输入和过去输入之间的矛盾。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `observation` | `string` | required | What seems contradictory / 看起来矛盾的内容 |
| `context` | `string` | — | Surrounding context / 周围上下文 |

---

#### `context_synthesize`

Synthesize journal content. With `consolidate=true`, promotes to palace rooms.

合成日志内容。使用 `consolidate=true` 时，提升到记忆宫殿房间。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `consolidate` | `boolean` | `false` | Write results into palace rooms / 将结果写入记忆宫殿房间 |

---

### Journal Tools | 日志工具

#### `journal_capture`

Lightweight Q&A capture. Appends to today's log.

轻量级问答捕获。追加到今天的日志。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | `string` | required | The human's question (summarized) / 人类的问题（摘要） |
| `answer` | `string` | required | The agent's answer (summarized) / Agent 的回答（摘要） |
| `tags` | `string[]` | — | Tags for this entry / 条目标签 |
| `palace_room` | `string` | — | Also write to a palace room / 同时写入记忆宫殿房间 |

#### `journal_write`

Write a full daily journal entry.

写完整的每日日志条目。

| Parameter | Type | Description |
|-----------|------|-------------|
| `content` | `string` | required | Full journal content (markdown) / 完整日志内容 |
| `section` | `string` | — | Specific section to write / 要写入的特定章节 |

#### `journal_read`

Read a journal entry by date.

按日期读取日志条目。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `date` | `string` | — | Date (YYYY-MM-DD) or "latest" / 日期或 "latest" |
| `section` | `string` | — | Filter to a specific section / 过滤特定章节 |

#### `journal_rollup`

Condense old daily journals into weekly summaries.

将旧的每日日志压缩为周报摘要。

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dry_run` | `boolean` | `false` | Preview without executing / 预览不执行 |
| `min_age_days` | `number` | `14` | Only roll up entries older than N days / 只压缩 N 天以前的条目 |

---

## See Also | 参见

- [[Core Concepts]] — how the tools fit into the memory pyramid / 工具如何融入记忆金字塔
- [[Getting Started]] — install and first session / 安装和第一次使用
- [[SDK API Reference]] — programmatic access / 编程访问
- [[CLI Commands]] — terminal usage / 终端使用
