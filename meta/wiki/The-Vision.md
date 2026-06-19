# The Vision | 愿景

**AgentRecall is not a memory tool. It's the beginning of human understanding.**

**AgentRecall 不是记忆工具。它是理解人类的起点。**

---

## The Problem No One Talks About | 没人谈论的问题

Every AI memory tool stores PROJECT data — what was built, what was decided, what's blocked. That's necessary but insufficient.

每个 AI 记忆工具都存储项目数据——构建了什么、决定了什么、阻塞了什么。这是必要的，但不够。

The real problem: **AI agents don't understand the HUMAN they're working with.**

真正的问题是：**AI agent 不理解与它们合作的人。**

- The same agent gives the same response to a senior architect and a first-time coder
- A person who corrects an agent 50 times gets the same treatment on correction #51
- When a human says "do it", different humans mean entirely different things — but the agent can't tell

- 同一个 agent 给资深架构师和第一次写代码的新手同样的回复
- 一个人纠正 agent 50 次后，第 51 次仍然得到相同的对待
- 当一个人说"做吧"，不同的人意味着完全不同的事情——但 agent 分辨不出来

This is the **Intelligent Distance** problem — a structural gap between how humans think and how AI agents work. The gap can't be eliminated. But it can be navigated better with every interaction.

这就是**智能距离**问题——人类思维方式和 AI agent 工作方式之间的结构性鸿沟。这个鸿沟无法消除。但可以在每次交互中更好地穿越它。

---

## The Goal | 目标

**The same agent should perform differently for different people, and better over time for the same person.**

**同一个 agent 应该对不同的人表现不同，对同一个人随时间表现更好。**

After 10 sessions, the agent should know:

10 次会话后，agent 应该知道：

| What it learns | How it knows | 如何知道的 |
|---|---|---|
| This person communicates in scattered, non-linear bursts | Pattern from 8 alignment checks | 8 次对齐检查的模式 |
| When they say "save" they mean "git push" | Correction from session 3, confirmed 4x | 第 3 次会话的纠正，确认 4 次 |
| They care about results, not process | Feedback: "stop summarizing what you just did" | 反馈："别再总结你刚做了什么" |
| When they're vague, it means they trust you | 6 sessions of high-confidence alignment checks | 6 次高信心对齐检查 |
| When they're specific, it means they got burned before | Correction pattern: specific instructions follow mistakes | 纠正模式：具体指令跟在错误之后 |

This isn't science fiction. It's pattern recognition on structured data that's already being collected.

这不是科幻。这是对已经在收集的结构化数据的模式识别。

---

## Where AgentRecall Is Today | AgentRecall 目前在哪里

### What works | 已经能做的

**Project memory** — AgentRecall reliably stores and recalls project context across sessions. Cold start, journal, palace, insights — these work and provide measurable value for multi-session projects.

**项目记忆** —— AgentRecall 可靠地跨会话存储和回忆项目上下文。冷启动、日志、记忆宫殿、洞察——这些已经工作，并为多会话项目提供可衡量的价值。

**Correction capture** — `alignment_check` records every human correction. The data is stored permanently.

**纠正捕获** —— `alignment_check` 记录每次人类纠正。数据被永久存储。

**Insight compounding** — the 200-line awareness cap forces merge-or-replace, so memory quality improves over time.

**洞察复利** —— 200 行感知上限强制合并或替换，所以记忆质量随时间提升。

### What's next | 下一步

**Communication model** — not just "what was said" but "how this person communicates." Scattered bursts vs. detailed specs. Prefers options vs. prefers recommendations. Learned, not manually coded.

**沟通模型** —— 不仅是"说了什么"，而是"这个人如何沟通"。零散爆发 vs. 详细规格。偏好选项 vs. 偏好推荐。被学习，而不是手动编码。

**Correction pattern analysis** — aggregating correction data over time. After 20 corrections, the system should know: "60% of this person's corrections are about scope (agent does too much), 30% about priority (agent does the wrong thing first)."

**纠正模式分析** —— 随时间聚合纠正数据。20 次纠正后，系统应该知道："这个人 60% 的纠正是关于范围的（agent 做太多），30% 是关于优先级的（agent 先做了错误的事）。"

**Behavioral adaptation** — accumulated understanding should shape the agent's approach BEFORE it starts reasoning about the task. Not just recall, but pre-conditioning.

**行为适应** —— 累积的理解应该在 agent 开始推理任务之前就塑造它的方法。不仅是回忆，而是预调节。

---

## The Bar | 标准

The question isn't "does it store data" — it does.

问题不是"它能存储数据吗"——它能。

The question is: **Does the agent behave measurably differently on session 50 than session 1 with the same person?**

问题是：**与同一个人的第 50 次会话，agent 的行为是否可以衡量地不同于第 1 次？**

That's the bar. Everything in AgentRecall is measured against it.

这是标准。AgentRecall 中的一切都以此为衡量。

---

## For Contributors | 给贡献者

If you want to help build this:

如果你想帮助构建这个：

1. **Alignment data is the goldmine.** Every `alignment_check` is a labeled data point: what the agent thought, what the human meant, what the gap was. Aggregating these into behavioral priors is the highest-leverage work.

   **对齐数据是金矿。** 每次 `alignment_check` 都是一个标注数据点：agent 认为的、人类意图的、鸿沟是什么。将这些聚合成行为先验是最高杠杆的工作。

2. **Fewer tools, deeper integration.** 22 tools is too many for most agents to use effectively. The path forward is fewer, smarter tools that do more automatically.

   **更少的工具，更深的集成。** 22 个工具对大多数 agent 来说太多了。前进的方向是更少、更智能的工具，更多地自动完成。

3. **Measure behavioral change.** Build evals that compare agent behavior on session 1 vs. session N with the same user profile. If there's no measurable difference, the memory system isn't working.

   **衡量行为变化。** 构建评估，比较同一用户配置下第 1 次和第 N 次会话的 agent 行为。如果没有可衡量的差异，记忆系统就没有在工作。

---

## See Also | 参见

- [[Intelligent Distance]] — the protocol in detail / 协议详解
- [[Core Concepts]] — how the memory layers work / 记忆层如何工作
- [README](https://github.com/Goldentrii/AgentRecall) — installation and quick start / 安装和快速入门
