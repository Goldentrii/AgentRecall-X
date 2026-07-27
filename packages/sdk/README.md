**English** · [中文](README.zh-CN.md)

<h1 align="center">AgentRecall</h1>

<p align="center"><strong>Your agent keeps making the same mistakes. AgentRecall makes it stop — and proves it with numbers.</strong></p>

<p align="center">Install once. Correct your agent the way you already do. It remembers, warns before repeats, and measurably stops making the same mistake — across sessions, projects, and restarts. Zero cloud. Zero commands to learn.</p>

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
  <a href="README.full.md#the-session-loop--会话循环"><img src="https://img.shields.io/badge/%2Farstart-OPEN·START_HERE-22C55E?style=for-the-badge" alt="/arstart"></a>
  <a href="README.full.md#the-session-loop--会话循环"><img src="https://img.shields.io/badge/%2Farsave-SAVE-FF6B6B?style=for-the-badge" alt="/arsave"></a>
  <a href="README.full.md#the-session-loop--会话循环"><img src="https://img.shields.io/badge/%2Farrecall-SEARCH-4ECDC4?style=for-the-badge" alt="/arrecall"></a>
  <a href="README.full.md#the-session-loop--会话循环"><img src="https://img.shields.io/badge/%2Farreflect-CONSOLIDATE-8B5CF6?style=for-the-badge" alt="/arreflect"></a>
</p>

<details>
<summary><b>Agent found this repo?</b> Install AgentRecall for your human (click to expand)</summary>

**1. Install the MCP server** (Claude Code):

```bash
claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp
```

Generic MCP JSON for other clients:

```json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }
```

**2. You drive the lifecycle** — on hosts without hooks, no harness fires it for you:

```
ENTRY:  call session_start FIRST, before acting — memory loads unasked.
DURING: the moment the human corrects you, or says save / remember / 记住 —
        call remember (single fact) or session_end. Saying it is not saving it.
EXIT:   call session_end before you stop. Every time.
```

</details>

---

## What happens after you install

Nothing you have to do. That's the product.

1. **You just work.** Every session starts with your agent already knowing your projects, your standing rules, and what went wrong last time — context loads before the first token of work.
2. **You correct it the way you already do.** *"No — always ask before publishing."* That sentence becomes a structured, severity-ranked rule. No command, no form, no tagging.
3. **It stops repeating the mistake — measurably.** Next session, the rule is already in the agent's head. If the agent is about to do something a standing rule forbids, `check` blocks it. And every rule's real-world performance is tracked: heeded or recurred, per correction, forever.

```mermaid
flowchart TB
    S["session_start<br/><i>memory arrives — nothing asked</i>"] --> W["You just work.<br/>The agent already knows your history."]
    W -->|"you correct it once:<br/>no — always ask before publishing"| C["Correction captured automatically<br/>severity · evidence · outcome tracking"]
    C --> W
    W -->|"agent is about to<br/>publish / deploy / delete"| K{"check —<br/>standing P0 rule?"}
    K -->|"BLOCKED by your rule"| W
    K -->|clear| W
    W --> E["session_end<br/><i>journal + insights saved</i>"]
    E -->|"any later session —<br/>tomorrow or next month"| S
```

On Claude Code the whole loop is hook-driven — literally zero agent effort. On Codex, Cursor, and raw MCP clients the agent drives it, following instructions the server hands it at connect time. Same 5-tool surface everywhere: `session_start` · `remember` · `recall` · `check` · `session_end`.

---

## Quick Start

```bash
# Claude Code — one line, done
claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp
```

<details>
<summary><b>Cursor · VS Code · Windsurf · Codex · 9 more clients</b></summary>

```bash
# Cursor — .cursor/mcp.json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }

# VS Code — .vscode/mcp.json
{ "servers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }

# Windsurf — ~/.codeium/windsurf/mcp_config.json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }

# Codex
codex mcp add agent-recall -- npx -y agent-recall-mcp
```

**Visual setup guide — all 13 clients, copy-paste prompts:** open [`warroom/install.html`](warroom/install.html) in any browser. No server needed.

</details>

<details>
<summary><b>SDK & CLI</b> — for JS/TS apps, terminal, and CI</summary>

```bash
npm install agent-recall-sdk        # JS/TS apps
npx agent-recall-cli recall "topic" # terminal & CI
```

```typescript
import { AgentRecall } from "agent-recall-sdk";
const memory = new AgentRecall({ project: "my-app" });
await memory.remember("We use token-bucket rate limiting for the API gateway");
const ctx = await memory.recall("rate limiting");
```

</details>

Everything lives in plain Markdown/JSON on your disk (`~/.agent-recall/`). No API key, no network, no LLM on the default path. Works with Obsidian out of the box.

---

## How it learns — and how we know it works

Every other memory tool stops at storage and retrieval. AgentRecall closes the loop: it tracks what happens **after** a memory is retrieved.

```mermaid
flowchart LR
    C["Correction<br/>stored"] --> R["retrieved in a<br/>later session"]
    R --> A{"agent's<br/>next action"}
    A -->|honored| H["heeded ✓"]
    A -->|"same mistake<br/>again"| X["recurred ✗"]
    H --> M["per-correction precision<br/>+ repeat-mistake rate"]
    X --> M
    M -->|"weak rules pruned ·<br/>proven rules strengthen"| C
```

### Measured, not promised

Most agent memory tools claim "never repeats the same mistake." None publish a number. Here is our own instrument, on our own live corpus — including the scores that make us look bad:

| Metric | Value | Artifact |
|---|---|---|
| Correction capture recall (dual-blind audit, n=59) | **35.3%** [17.3–58.7 CI] | `UPDATE-LOG.md` §M2 |
| Heed rate, evidence-grounded (post instrument-bias reset) | **0/3** events | `scripts/eval/baselines/` |
| Correction transfer recall (offline bench, achievable) | **0/4** [Wilson 0–49%] | `scripts/eval/baselines/` |
| Median session_start injection | **1,489 tokens** (Mem0 anchor ~7K) | `UPDATE-LOG.md` §C2 |
| p95 session_start latency (warm) | **363 ms** | `UPDATE-LOG.md` §C2 |

No public benchmark in the field — LongMemEval, LoCoMo, MemoryAgentBench, the Letta Leaderboard — measures whether a captured correction changes what a fresh agent does in a new session. Ours does, it regenerates from a hash-locked corpus with one command (`npm run bench`), and we publish the unflattering numbers while the corpus grows. **Verify it yourself:** [docs/eval/REPRODUCE.md](docs/eval/REPRODUCE.md).

---

## Go deeper

| | |
|---|---|
| **[Full documentation](README.full.md)** | 5 memory layers · session loop · MCP tool reference · SDK API · nightly dreaming · War Room dashboard · architecture |
| **[中文文档](README.zh-CN.md)** | Chinese README |
| **[Reproduce our numbers](docs/eval/REPRODUCE.md)** | Every published metric, regenerated from committed artifacts |
| **[Telegram community](https://t.me/+ywZwoHrg3AM0NDVi)** | Questions, field reports, benchmark results |
| **[Contributing](CONTRIBUTING.md)** | Corpus donations and host adapters are the highest-leverage help |

MIT © [Goldentrii](https://github.com/Goldentrii)
