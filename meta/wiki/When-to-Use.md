# When to Use | 何时使用

AgentRecall is not "always on" overhead. It's a tool with a clear break-even point.

AgentRecall 不是"始终开启"的开销。它是一个有明确盈亏平衡点的工具。

---

## The Rule | 规则

**Default: USE IT.** Most projects are long-term and benefit from memory. Memory compounds — a small overhead today saves large context-rebuilding costs across future sessions.

**默认：使用它。** 大多数项目是长期的，记忆对它们有益。记忆是复利的——今天的小开销，能节省未来会话中大量的上下文重建成本。

**Skip only when** the task is truly single-session throwaway work.

**仅在** 任务确实是一次性的临时工作时跳过。

---

## Decision Guide | 决策指南

### Use AgentRecall | 使用 AgentRecall

| Situation | Why | 为什么 |
|-----------|-----|--------|
| Multi-session project (3+ sessions expected) | Memory compounds across sessions | 记忆跨会话复利 |
| Resuming work from a previous session | Cold start loads context in ~200 tokens | 冷启动用约 200 tokens 加载上下文 |
| Non-obvious decisions being made | Future agents need to know WHY, not just WHAT | 未来的 agent 需要知道「为什么」而不仅是「是什么」 |
| Multiple people or agents touch the same project | Shared memory prevents repeated mistakes | 共享记忆防止重复犯错 |
| Cross-project work | Insights from Project A surface in Project B | 项目 A 的洞察在项目 B 中浮现 |

### Skip AgentRecall | 跳过 AgentRecall

| Situation | Why | 为什么 |
|-----------|-----|--------|
| Pure Q&A session | No project context to save | 没有需要保存的项目上下文 |
| Trivial one-off script | Won't be revisited | 不会再用 |
| Quick fix with no decisions | Nothing worth recalling | 没有值得回忆的内容 |

---

## The Evidence | 证据

We ran a controlled experiment (2026-04-10) comparing token usage with and without AgentRecall on a simple CLI task (CSV-to-JSON converter):

我们进行了一个对照实验（2026-04-10），比较在简单 CLI 任务（CSV 转 JSON 工具）上使用和不使用 AgentRecall 的 token 用量：

| Metric / 指标 | Without AR / 无 AR | With AR / 有 AR | Delta / 差异 |
|---|---|---|---|
| Total tool calls / 总工具调用 | 9 | 17 | +8 (+89%) |
| Functional tool calls / 功能性调用 | 9 | 9 | 0 |
| AR tool calls / AR 工具调用 | 0 | 8 | +8 |
| Est. token overhead / 预估 token 开销 | 0 | ~2,300 | +~30% |
| Corrections needed / 需要修正次数 | 0 | 0 | 0 |
| Rework count / 返工次数 | 0 | 0 | 0 |

**Result for simple task: pure overhead.** No insight matched. No prior context was useful.

**简单任务的结果：纯开销。** 没有匹配到任何洞察。没有先前上下文有用。

**But this is the exception, not the rule.** 但这是例外，不是常态。

For a multi-session project, the math flips:

对于多会话项目，算术反转：

| Scenario / 场景 | AR overhead / AR 开销 | Context rebuild cost without AR / 无 AR 上下文重建成本 | Net / 净效果 |
|---|---|---|---|
| 1 session, simple task / 1 次会话，简单任务 | ~2,300 tokens | 0 | -2,300 (waste / 浪费) |
| 3 sessions, medium project / 3 次会话，中等项目 | ~6,900 tokens | ~5,000-10,000 tokens re-explaining | Break-even / 持平 |
| 10 sessions, complex project / 10 次会话，复杂项目 | ~23,000 tokens | ~50,000-100,000 tokens lost context | +27,000-77,000 saved / 节省 |

---

## Dynamic Equilibrium | 动态平衡

AgentRecall usage is a **dynamic equilibrium**, not a binary switch.

AgentRecall 的使用是一个**动态平衡**，不是一个二元开关。

The right question is not "should I use it?" but "will a future session benefit from today's context?"

正确的问题不是「我应该使用它吗？」而是「未来的会话会从今天的上下文中受益吗？」

- **Cost is immediate** — tokens spent now on tool calls / 成本是即时的——当下花在工具调用上的 tokens
- **Value is deferred** — future sessions benefit from today's writes / 价值是延迟的——未来的会话从今天的写入中受益
- **Value compounds** — each insight strengthens or replaces, so 100 sessions later, memory is still 200 lines but each line carries more weight / 价值是复利的——每条洞察强化或替换旧的，所以 100 次会话后，记忆仍然是 200 行，但每一行都承载更多分量

For most real work, the long-term benefit far outweighs the per-session cost.

对于大多数实际工作，长期收益远超单次会话成本。

---

## See Also | 参见

- [[Getting Started]] — install and first session / 安装和第一次使用
- [[Core Concepts]] — how the memory layers work / 记忆层如何工作
