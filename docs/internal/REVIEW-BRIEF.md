# AgentRecall — Introduction, Methodology & Review Brief

---

## Part 1: Introduction for the Reviewer

### What AgentRecall Is

AgentRecall is a persistent memory system for AI agents. It gives agents the ability to remember across sessions — not just facts, but behavioral corrections, decisions, patterns, and the human's working style. When a human corrects an agent ("no dark backgrounds"), that correction is captured, classified, stored, and automatically surfaced in every future session where it's relevant.

**One-line:** "Your agent doesn't just remember. It learns how you think."

### The Background: Why This Exists

AI agents are stateless by default. Every new conversation starts from zero. The human has to re-explain their project, preferences, past decisions, and corrections. For a one-off task, this is fine. For ongoing collaboration (weeks, months, years), this creates a compounding tax:

- Session 1: human explains everything (1000 tokens)
- Session 2: human re-explains everything (1000 tokens again)
- Session 50: human has given the same correction 12 times and the agent still makes the same mistake

The deeper problem isn't memory storage — it's what tongwu calls **Intelligent Distance**: the structural, permanent gap between human intelligence and AI intelligence. Humans are born (embodied, emotional, survival-driven). AI is trained (statistical, pattern-matching). This gap doesn't close as AI improves — it's structural, rooted in different cognitive origins.

AgentRecall doesn't try to close this gap. It builds a **bridge** — a protocol layer that minimizes information loss when translating between the two intelligence types. The most valuable information crossing that bridge is **corrections**: when a human says "wrong," that signal carries more meaning per token than any fact.

### The Methodology

AgentRecall is built on three principles:

**1. Corrections over facts.** LLM providers will ship native memory for facts ("user prefers Next.js"). They won't ship a behavioral correction protocol — the structured capture of human feedback, its auto-classification by severity, and its propagation across agents, sessions, and projects. This is AgentRecall's long-term moat.

**2. Hooks over discretion.** The biggest design lesson: asking agents to decide when to save is like asking a tired human to decide when to take notes. They forget under load. Critical saves (session end, correction capture, ambient recall) are harness-enforced via hooks — they fire automatically regardless of agent state.

**3. Facts over judgment in metadata.** File naming uses line counts (objective, computable) not importance weights (subjective, error-prone). The agent decides relevance using its own context. The system provides cost signals, not judgment calls.

### What's Been Built (v3.3.20)

| Layer | What | How |
|-------|------|-----|
| **5 MCP tools** | session_start, remember, recall, session_end, check (+digest) | Standard MCP protocol, works with Claude/Cursor/any client |
| **4 harness hooks** | hook-start, hook-end, hook-correction, hook-ambient | Fire automatically on session events — no agent discretion |
| **3 commands** | /arsave, /arstart, /arsaveall | One-instruction simplicity for humans |
| **Multi-label tags** | 3-6 semantic tags per memory (domain, type, area) | Rule-based at save time, +0.3 bonus in search |
| **Corrections store** | Separate from journal/palace, never rolled up, always loaded | Auto-severity (P0/P1) from language patterns |
| **Consistency checker** | Detects version conflicts, status contradictions, stale memories | Runs at save time, returns warnings |
| **Intelligent naming** | `{date}--{saveType}--{lines}L--{slug}.md` | Parseable by agents, readable by humans |
| **Scoring** | RRF (Cormack 2009) + Ebbinghaus decay + Bayesian Beta feedback | Cross-source ranking without raw score comparison |

### Architecture

```
~/.agent-recall/projects/{project}/
  journal/          ← daily session logs (ephemeral, fast decay)
  corrections/      ← behavioral rules (permanent, always loaded)
  palace/
    rooms/          ← semantic knowledge (architecture, goals, blockers...)
    awareness.json  ← compounding insights
    graph.json      ← room connections
  feedback-log.json ← recall quality feedback
```

4-package monorepo: core (engine), mcp-server (6 tools), sdk (JS/TS API), cli (`ar` command).

### The Goal

**Short-term (now):** A memory system that makes agents measurably better at recurring projects — fewer repeated mistakes, less re-explanation, compounding knowledge.

**Medium-term (6-12 months):** A behavioral calibration layer — agents don't just remember what you said, they adjust how they work based on accumulated corrections.

**Long-term (12-24 months):** A protocol — like MCP standardized tool access, AgentRecall standardizes how agents remember, learn, and adapt to humans. Cross-LLM, cross-platform, open.

**The bar:** Does the agent behave measurably differently on session 50 than session 1 with the same person?

---

## Part 2: Review Prompt for Fresh Agent

### Mission: Independent Review of AgentRecall

You are a fresh reviewer with no prior context on this project. Your job is to evaluate AgentRecall honestly from multiple perspectives and answer one core question:

**What IS AgentRecall — a skill, a harness, or an OS? And does it matter?**

### Setup

1. Read the full codebase at `~/Projects/AgentRecall/`
2. Read `UPDATE-LOG.md` for the improvement history
3. Read `packages/core/src/` for the engine logic
4. Read `packages/mcp-server/src/` for the MCP tool surface
5. Read `packages/cli/src/index.ts` for hooks and CLI commands
6. Read `~/.agent-recall/` for the actual stored data (journals, palace, corrections)
7. Read `~/.claude/commands/arsave.md` for the human-facing command

### What to Evaluate

#### A. Identity Classification

Is AgentRecall:
- **A skill?** — A set of instructions that tells agents how to do something (like a SKILL.md file)
- **A harness?** — An infrastructure layer that constrains and orchestrates agent behavior (like hooks, settings, enforced workflows)
- **An OS?** — A complete operating environment that manages agent lifecycle, memory, knowledge, and behavioral adaptation
- **Something else?** — A protocol? A framework? A hybrid?

Give your classification with reasoning. Don't force it into one category if it spans multiple.

#### B. Agent Experience (the most important section)

Evaluate from the perspective of an AI agent that uses AgentRecall daily:

1. **Onboarding friction** — How many steps to go from `npm install` to useful memory? Is the cold start clear?
2. **Tool surface clarity** — 5 MCP tools + legacy 22. Is it confusing? Do agents know which tool to call when?
3. **Hook reliability** — Do the 4 hooks (start, end, correction, ambient) actually fire consistently? Are there edge cases where they fail silently?
4. **Recall quality** — Does `recall()` return useful results? Or does it surface noise? How good is RRF + Ebbinghaus in practice?
5. **Correction lifecycle** — From "human says no" → hook-correction captures it → stored as P0 → loaded at session_start. Is this chain reliable? Where does it break?
6. **Naming system** — The new `{date}--{saveType}--{lines}L--{slug}.md` format. Is it actually useful for agents scanning directories? Or is it overhead?
7. **Consistency** — Run the consistency tests (`npm test` in packages/core). Are there other inconsistencies the tests don't catch?
8. **Context cost** — What's the actual token overhead per session? Is it worth it for a 3-session project? A 20-session project?

#### C. Human Experience

1. **One-instruction simplicity** — Can a human type `/arsave` and trust everything is saved? What could go wrong?
2. **Transparency** — Does the human know what was saved, where, and why? Or is it a black box?
3. **The `.agent-recall/` directory** — Open it in Finder/Obsidian. Is the file structure understandable?

#### D. Competitive Position

Compare to:
- Claude Code's built-in auto-memory (MEMORY.md in `.claude/projects/`)
- Mem0 (53K stars, cloud-based, vector DB)
- Letta/MemGPT (22K stars, multi-tier memory)
- Graphiti (25K stars, knowledge graphs)

What does AgentRecall do that none of these do? What do they do better?

#### E. Architecture Critique

1. **Local-only, no vector DB** — Is this a strength (zero infra, human-readable) or a weakness (no semantic search)?
2. **RRF + Ebbinghaus + Beta** — Is the scoring mathematically sound? Does it actually outperform simple keyword search?
3. **The palace metaphor** — Rooms, salience, connections. Does this structure help agents organize knowledge, or is it an abstraction that adds complexity without benefit?
4. **Multi-window safety** — Session-ID scoping, filelock. Does it actually prevent conflicts?

### Output Format

```
## Classification: [skill / harness / OS / hybrid]
Reasoning: ...

## Agent Experience Score: X/10
[Detail per criterion above]

## Human Experience Score: X/10
[Detail per criterion]

## Competitive Position
[What's unique, what's missing]

## Architecture: Strengths & Weaknesses
[Honest assessment]

## Top 3 Things to Keep
1. ...
2. ...
3. ...

## Top 3 Things to Fix
1. ...
2. ...
3. ...

## Verdict
[One paragraph: is this project worth continuing? What should it become?]
```

### Rules for the Reviewer

- **Be brutally honest.** The creator wants real feedback, not encouragement.
- **Test things, don't just read.** Run the MCP tools. Check the hooks. Open the files.
- **Compare to alternatives.** If Mem0 does something better, say so.
- **Think as an agent.** You ARE an agent. What would make YOUR life easier?
- **Don't suggest features.** Identify problems. The creator will decide what to build.
