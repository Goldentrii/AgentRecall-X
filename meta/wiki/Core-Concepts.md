# Core Concepts | 核心概念

AgentRecall is built on a five-layer memory pyramid. Each layer serves a different purpose, at a different speed, with different persistence.

AgentRecall 建立在五层记忆金字塔之上。每一层服务于不同的目的，以不同的速度运作，具有不同的持久性。

---

## The Memory Pyramid | 记忆金字塔

```
        ┌─────────────┐
        │  Awareness   │  ← Cross-project insights, 200-line cap
        │   感知系统    │     跨项目洞察，200 行上限
        ├─────────────┤
        │   Palace     │  ← Structured rooms (architecture, goals, blockers)
        │  记忆宫殿    │     结构化房间（架构、目标、阻塞项）
        ├─────────────┤
        │   Journal    │  ← Daily session logs
        │    日志      │     每日会话日志
        ├─────────────┤
        │   Capture    │  ← Quick Q&A pairs during a session
        │   快速捕获   │     会话中的快速问答对
        ├─────────────┤
        │  Alignment   │  ← Gap between human intent and agent action
        │   对齐检查   │     人类意图与 agent 行动之间的鸿沟
        └─────────────┘
```

**Key insight:** Data flows UP the pyramid. Quick captures become journal entries. Journal entries consolidate into palace rooms. Palace patterns become awareness insights. Each level is more compressed and more valuable.

**关键洞察：** 数据沿金字塔向上流动。快速捕获变成日志条目。日志条目整合到记忆宫殿。宫殿模式变成感知洞察。每一层更压缩、更有价值。

---

## Layer 1: Capture | 第一层：快速捕获

The lightest weight memory operation. Records a question-answer pair with optional tags.

最轻量的记忆操作。记录一个问答对，可附带标签。

```
Tool: journal_capture
Input: question + answer + optional tags
Output: Appended to today's journal
```

**When to use:** During a session when a key decision is made or an important question is answered. Think of it as a bookmark — not everything needs to be captured, just the things a future agent would need.

**何时使用：** 在会话中做出关键决策或回答重要问题时。把它想象成书签——不是所有事情都需要捕获，只捕获未来 agent 会需要的。

**Example / 示例:**
```
Q: "What database?"
A: "Postgres via Drizzle ORM — type-safe, lightweight, team already knows it"
Tags: ["decision", "architecture"]
```

---

## Layer 2: Alignment Check | 第二层：对齐检查

Measures the **Intelligent Distance** — the gap between what the human meant and what the agent understood.

测量**智能距离**——人类意图与 agent 理解之间的鸿沟。

```
Tool: alignment_check
Input: goal (agent's understanding) + confidence + assumptions
Output: Logged for pattern analysis
```

**When to use:** Before starting a significant piece of work. The agent states what it thinks the goal is, its confidence level, and its assumptions. If the human corrects it, that correction is stored permanently.

**何时使用：** 在开始一项重要工作之前。Agent 陈述它认为的目标、信心水平和假设。如果人类纠正了它，该纠正会被永久存储。

**Why this matters / 为什么重要:**

Over time, alignment checks reveal PATTERNS in misunderstanding:
- "60% of corrections are about scope — I do too much"
- "30% are about priority — I do the wrong thing first"

随着时间推移，对齐检查揭示了误解的模式：
- "60% 的纠正是关于范围的——我做得太多"
- "30% 是关于优先级的——我先做了错误的事"

This is the foundation of the [[Intelligent Distance]] protocol.

这是 [[智能距离]] 协议的基础。

---

## Layer 3: Journal | 第三层：日志

Daily session logs that record what happened, what was decided, and what's next.

每日会话日志，记录发生了什么、决定了什么、下一步是什么。

```
Tool: journal_write / journal_read / journal_capture
Storage: ~/.agent-recall/projects/<name>/journal/YYYY-MM-DD.md
```

**Sections / 章节:**
1. **Brief** — cold-start table (project / last done / next step / momentum)
2. **Completed** — what got done, with specifics
3. **Blockers** — honest assessment of what's stuck
4. **Next** — prioritized next actions
5. **Decisions** — what was decided and WHY

**Auto-compaction / 自动压缩:** Old journals are automatically rolled up into weekly summaries via `journal_rollup`, keeping only the essential decisions and lessons.

旧日志通过 `journal_rollup` 自动压缩为周报摘要，只保留核心决策和经验教训。

---

## Layer 4: Memory Palace | 第四层：记忆宫殿

Structured rooms that organize knowledge by topic. Named after the ancient mnemonic technique — each "room" holds related memories.

按主题组织知识的结构化房间。以古老的记忆术命名——每个"房间"存放相关的记忆。

```
Tool: palace_write / palace_read / palace_walk / palace_search
Storage: ~/.agent-recall/projects/<name>/palace/<room>/
```

**Common rooms / 常见房间:**

| Room | Contains | 包含内容 |
|------|----------|---------|
| `architecture` | Tech stack, design decisions, patterns | 技术栈、设计决策、模式 |
| `goals` | Active goals, completed goals, evolution | 活跃目标、已完成目标、演变 |
| `blockers` | Current blockers and workarounds | 当前阻塞项和变通方案 |
| `identity` | Project purpose, constraints, principles | 项目目的、约束、原则 |

**Cross-references / 交叉引用:** Use `[[wikilinks]]` in palace content to create connections between rooms. `palace_write` automatically fans out references to connected rooms.

在记忆宫殿内容中使用 `[[wikilinks]]` 创建房间之间的连接。`palace_write` 会自动将引用扩散到连接的房间。

**Progressive loading / 渐进式加载:** `palace_walk` loads context at different depths:

| Depth / 深度 | Tokens | What's loaded / 加载内容 |
|------|--------|-------------|
| `identity` | ~50 | Project name and purpose / 项目名称和目的 |
| `active` | ~200 | Top rooms by salience + awareness / 按显著性排序的顶部房间 + 感知 |
| `relevant` | ~500 | Rooms matching a focus query / 匹配焦点查询的房间 |
| `full` | ~2000 | Everything / 全部 |

---

## Layer 5: Awareness | 第五层：感知系统

The highest layer. Cross-project insights that compound over time. Capped at 200 lines — new insights either merge with existing ones (strengthening them) or replace the weakest.

最高层。跨项目的洞察，随时间复利。上限 200 行——新洞察要么与现有的合并（强化它们），要么替换最弱的。

```
Tool: awareness_update / recall_insight
Storage: ~/.agent-recall/projects/<name>/awareness.md + insights/index.md
```

**How compounding works / 复利如何运作:**

```
Session 1: Insight added — "structurize scattered input" (confirmed 1x)
Session 5: Same pattern seen — merged, now confirmed 3x, higher salience
Session 20: Insight is top-3 in awareness — surfaces on every cold start
Session 50: Insight is battle-tested — 12x confirmed, shapes agent behavior
```

**The 200-line cap is the feature, not the limitation.** Without it, memory grows linearly and becomes noise. The cap forces merge-or-replace, so memory gets MORE valuable over time, not less.

**200 行上限是特性，不是限制。** 没有它，记忆线性增长，变成噪声。上限强制合并或替换，所以记忆随时间变得更有价值，而不是更没价值。

---

## How the Layers Interact | 各层如何交互

```
Session Start                    During Session                  Session End
会话开始                          会话期间                        会话结束

/arstart                         Work normally                   /arsave
  │                              正常工作                          │
  ├─ recall_insight                │                              ├─ journal_write
  │  (awareness → agent)           ├─ journal_capture             │  (session → journal)
  │                                │  (Q&A → journal)             │
  ├─ palace_walk                   │                              ├─ context_synthesize
  │  (palace → agent)              ├─ alignment_check             │  (journal → palace)
  │                                │  (gap → log)                 │
  └─ Ready to work                 │                              ├─ awareness_update
     准备工作                       └─ palace_write                │  (patterns → awareness)
                                      (decisions → palace)        │
                                                                  └─ Done. Push to git?
                                                                     完成。推送到 git？
```

---

## The 5-Tool Starter Set | 5 个核心工具入门集

Of 22 tools, these 5 cover 90% of daily use:

22 个工具中，这 5 个覆盖 90% 的日常使用：

| Tool / 工具 | When / 何时 | One-line / 一句话 |
|------|------|----------|
| `recall_insight` | Session start / 会话开始 | Surface relevant lessons / 浮现相关经验 |
| `palace_walk` | Session start / 会话开始 | Load project context / 加载项目上下文 |
| `journal_capture` | During work / 工作中 | Bookmark a key decision / 标记关键决策 |
| `alignment_check` | Before big tasks / 大任务前 | Measure understanding gap / 测量理解鸿沟 |
| `awareness_update` | Session end / 会话结束 | Extract compounding insights / 提取复利洞察 |

Start with these. Add more tools as needed. See [[MCP Tools Reference]] for the full list.

从这些开始。按需添加更多工具。完整列表参见 [[MCP 工具参考]]。

---

## See Also | 参见

- [[Intelligent Distance]] — the protocol behind alignment checks / 对齐检查背后的协议
- [[The Vision]] — why AgentRecall exists / AgentRecall 为什么存在
- [[MCP Tools Reference]] — all 22 tools in detail / 全部 22 个工具详解
