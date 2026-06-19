# Intelligent Distance | 智能距离

**The gap between what humans mean and what AI agents do is structural. It can't be closed — but it can be navigated better every session.**

**人类意图和 AI agent 行为之间的鸿沟是结构性的。它无法消除——但可以在每次会话中更好地穿越。**

---

## The Problem | 问题

When a human says "build me a landing page," they mean something specific — a particular style, a specific audience, a set of unstated constraints. The agent receives the words but invents its own WHY and HOW. Usually wrongly.

当人类说"给我建一个着陆页"，他们的意思很具体——特定的风格、特定的受众、一系列未说明的约束。Agent 接收了文字，但自己发明了「为什么」和「怎么做」。通常是错的。

```
Human gives: WHAT (build a landing page)
Agent invents: WHY (to convert visitors) ← maybe wrong
Agent invents: HOW (use hero + features + CTA) ← maybe wrong
```

This isn't a communication failure — it's a structural limitation. Humans think in context, emotion, and implicit knowledge. Agents think in explicit instructions. The translation is always lossy.

这不是沟通失败——而是结构性限制。人类在上下文、情感和隐性知识中思考。Agent 在显式指令中思考。翻译总是有损的。

---

## The Protocol | 协议

Intelligent Distance doesn't try to make the gap disappear. It makes the gap visible, measurable, and shrinkable over time.

智能距离不试图让鸿沟消失。它让鸿沟可见、可测量、可随时间缩小。

### Step 1: Measure the gap | 第一步：测量鸿沟

Before starting significant work, the agent uses `alignment_check`:

在开始重要工作之前，agent 使用 `alignment_check`：

```json
{
  "goal": "Build a landing page for the SaaS product",
  "confidence": "medium",
  "assumptions": [
    "Hero section with headline and CTA",
    "Features grid below",
    "Dark theme based on the dashboard"
  ],
  "unclear": "Whether to include pricing on this page"
}
```

The human reviews and corrects:

人类审查并纠正：

```json
{
  "human_correction": "No pricing — this is a waitlist page, not a sales page. Light theme. And the CTA is email signup, not 'get started'.",
  "delta": "Goal type wrong (waitlist vs sales), theme wrong, CTA wrong"
}
```

### Step 2: Store the correction | 第二步：存储纠正

The correction is stored permanently in the journal and can be promoted to awareness:

纠正被永久存储在日志中，可以提升到感知系统：

```
Insight: "This human's landing pages are waitlist-first, not sales-first"
Confirmed: 1x
Applies when: landing page, marketing, homepage
```

### Step 3: Surface before repeat | 第三步：在重复之前浮现

Next time a landing page task comes up, `recall_insight` surfaces:

下次着陆页任务出现时，`recall_insight` 浮现：

```
💡 Relevant insight: "Landing pages are waitlist-first, not sales-first" (confirmed 1x)
```

The agent adjusts BEFORE making the same mistake.

Agent 在犯同样的错误之前就进行调整。

---

## Types of Gap | 鸿沟的类型

| Category | Example gap | 示例鸿沟 |
|----------|------------|---------|
| **Goal** | Agent thinks "build" means "from scratch"; human meant "adapt the template" | Agent 认为"构建"是从零开始；人类的意思是"改编模板" |
| **Scope** | Agent builds 5 features; human wanted 1 | Agent 构建了 5 个功能；人类只要 1 个 |
| **Priority** | Agent starts with UI; human wanted API first | Agent 从 UI 开始；人类想先做 API |
| **Technical** | Agent picks React; codebase is Vue | Agent 选了 React；代码库是 Vue |
| **Aesthetic** | Agent uses dark theme; brand is light | Agent 用深色主题；品牌是浅色的 |

Over time, alignment checks reveal which gap types occur most often for a given person. That's the path to systematic improvement.

随着时间推移，对齐检查揭示哪种类型的鸿沟对特定人最常出现。这是系统性改进的路径。

---

## Key Principles | 关键原则

1. **Don't try to communicate better** — the gap is structural, not linguistic. Better prompts help marginally. Better measurement helps fundamentally.

   **不要试图更好地沟通** —— 鸿沟是结构性的，不是语言性的。更好的提示只有边际帮助。更好的测量有根本帮助。

2. **Give SMART goals, not detailed instructions** — measurable results, not step-by-step recipes. Let the agent discover HOW through trial, error, and correction.

   **给 SMART 目标，而不是详细指令** —— 可衡量的结果，而不是逐步配方。让 agent 通过试错和纠正发现「怎么做」。

3. **Every correction is training data** — when the human says "no, not that," that's the most valuable signal in the entire interaction. Store it, weight it, recall it.

   **每次纠正都是训练数据** —— 当人类说"不，不是那个"，这是整个交互中最有价值的信号。存储它、加权它、回忆它。

4. **The gap should shrink per person, not per model** — a better model doesn't help if it doesn't know THIS human's preferences. Person-specific learning beats general capability.

   **鸿沟应该按人缩小，而不是按模型** —— 一个更好的模型如果不知道这个人的偏好就没有帮助。针对个人的学习胜过通用能力。

---

## Further Reading | 延伸阅读

- [Intelligent Distance Protocol — Full Spec](https://github.com/Goldentrii/AgentRecall/blob/main/docs/intelligent-distance-protocol.md)
- [[Core Concepts]] — the memory pyramid / 记忆金字塔
- [[The Vision]] — where this is heading / 这将走向何方
