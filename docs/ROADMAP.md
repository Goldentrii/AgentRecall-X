# AgentRecall roadmap

The core product roadmap. Each item says why it matters, what it covers, and how we know it is done. Shipped work moves to [CHANGELOG.md](../CHANGELOG.md).

## Token usage: what memory costs, and what it saves

**Status:** proposed (owner request, 2026-11-21).

### Why

An agent owner should be able to answer two questions from AgentRecall itself: how many tokens does memory add to my agents' sessions, and how does that compare to the work they do? Today AgentRecall cannot answer either.

- Every token figure in the product is an estimate, not a tokenizer count. The published one comes from a fixture: the README's "88 tokens for `session_start`" is the `bench:injection` median on the golden-v1 fixture (the latest baseline is 87).
- No call records the total size of its response. `session_start`, `recall`, `session_end`, `remember`, `check` and the hook injections (`ar hook-start`, `hook-ambient`) are never measured as a whole when they run. The only live size record is the A/B experiment's `payload_tokens`, which covers the corrections section of `session_start` and is written only while that experiment runs. The hosted server's daily stats count calls per tool, never bytes or tokens.
- Nothing measures the agent's own work, so the split between memory and work cannot be computed.
- The estimators disagree: characters divided by 4 in the bench, the handoff and the A/B log, and by 3.5 for the digest's `tokens_saved_estimate`.

### What

1. **One estimator.** A single shared `estimateTokens()` in core, used by the bench, the handoff, the digest and everything below. It is labelled an estimate wherever it is shown. A real tokenizer can replace it later behind the same function.
2. **Record each memory call.** For every MCP tool call and every hook injection, record the tool, the project, the response size in bytes and the estimated tokens. Sizes only, never content.
   - Local: a new `telemetry/usage.jsonl` next to `lifecycle.jsonl`. The lifecycle log has no size fields and covers only four events, so adding sizes there would be a schema change.
   - Hosted: add byte and token sums per tool to the daily stats snapshot, summed over all users. That snapshot promises to hold no user or account ids (PRIVACY.md, "Daily usage counts"), and the sums keep that promise.
3. **Show it.**
   - `ar stats` gets a token section: per day and per project, per tool, with the median `session_start` size from real sessions next to the fixture figure.
   - Tool responses that already compute a size (`tokens_estimate` in the handoff) return it.
   - Per-user or per-agent token totals on the hosted server (for example on `/review`) are a separate decision. PRIVACY.md lists exactly what is stored per agent (app name, first and last seen, last tool, call count), so this needs a PRIVACY.md change and a retention period first.
4. **Memory against work.** Where the host exposes its own usage, read it to put memory tokens next to total session tokens. On Claude Code, the Stop hook payload carries the transcript path (`ar hook-end` already reads it). Whether that transcript records per-message usage is still to be verified. This is opt-in and local only. Hosts that expose nothing show memory tokens alone.
5. **What memory saves.** Count the corrections that were heeded instead of repeated (the heed events `ar stats` already counts) and attach an estimated cost per avoided repeat. Always labelled an estimate, never mixed with measured numbers.

### Done when

- `ar stats` shows measured memory tokens per day, project and tool, and the hosted daily stats show the sums per tool.
- The README's `session_start` figure is backed by real-session medians, with the fixture figure kept as the regression gate.
- On Claude Code, a session's memory tokens appear as a share of its total tokens.
- One estimator is used everywhere, and the CHANGELOG says how it counts.

### Out of scope

- Sending any usage data off the machine for self-hosted or local users.
- Per-user token data on the hosted server, until PRIVACY.md is changed for it.
- Billing or quotas based on tokens.

## Feedback on Agent Craft

**From:** Claude (Opus 5.5), while orchestrating the 3.5.4 release on 2026-11-21. **Asked for by:** the owner.

Agent Craft compiles sub-agent briefs into a structured SOP (`agent_craft_compile`), and a PreToolUse hook suggests compiling when an `Agent` call carries a long brief. Below is what one release session showed, checked against Agent Craft's own scoreboard (`agent_craft_stats` on 2026-11-21: 35 briefs, 34 with feedback).

**What works**

- The CHALLENGE section is the strongest part. It caught a false premise in 70.6% of the dispatches it applied to (24 of 34), and no caller has ever replaced it.
- ROLE, CONTEXT, SUCCESS_WHEN, PRECONDITIONS and ASSERT_INVARIANT survive dispatch almost every time. These are the sections that carry the value.

**What does not**

- **The hook nudges briefs it says it skips.** Its message says review, analysis and research briefs are not nudged, but it nudged twice in this session: a read-only release review and a read-only code survey. The survey brief also had a checklist of 5 `-` bullets, which the message says is exempt too, so `-` bullets do not seem to count as a checklist.
- **The compiled body is rewritten almost every time.** Only 5.9% of compiled briefs went out unedited (94.1% were edited). On the `systematic` route, 100% of compiled briefs still had placeholders the caller had to fill, and the generic `body-scaffold` section was replaced in 18 of 18 dispatches. `agent_craft_stats` itself lists `scaffold:systematic` as a demotion candidate.
- **The nudge can point at a tool that is not there.** In this session the `agent_craft` MCP server dropped out and came back, while the hook kept recommending `agent_craft_compile`.
- **For one-shot briefs, compiling costs more than it returns.** Both nudged briefs were one-shot and read-only, and each already had a role, a scope and an output contract. Compiling would have added a round trip and an edit pass without adding a section the brief lacked.

**Suggestions**

1. Make the hook match its own exemption rules: skip briefs that contain an output contract (`Output:`), `-` or `*` bullet checklists, or the words review, survey or research in the description. Measure its false-positive rate.
2. Drop the generic body scaffold from the `systematic` route and emit only the sections that survive: ROLE, CONTEXT, PRECONDITIONS, SUCCESS_WHEN, CHALLENGE.
3. Offer CHALLENGE on its own: a hook or validator check that adds a CHALLENGE clause to any brief, without compiling the rest.
4. Skip the nudge when the `agent_craft` tools are not loaded in the session.
5. Record the dispatch's token cost with `agent_craft_feedback`, so the scoreboard can weigh a brief's quality against what it cost (this connects to the token usage item above).
