# Hand-off Brief — AgentRecall "War Room" Panel Design

**To:** claude-design (or any design-capable agent)
**From:** tongwu (via Claude orchestrator)
**Date:** 2026-06-08
**Deliverable:** One self-contained `dashboard.html` file showing six live-data panels.

You are designing **the visual** only. No backend, no real data — fake JSON inlined. The orchestrator will wire your design to real data afterward.

---

## 1. Project context (read this first)

**AgentRecall** is a persistent memory layer for AI coding agents. It runs locally on the user's Mac, stores everything as markdown files under `~/.agent-recall/`, and currently has 16 active projects, 5 memory layers per project (journal / palace / awareness / pipeline / skills + corrections), plus cross-project insights. It is published on npm as `agent-recall-mcp` at v3.4.21.

The product's **moat** is the **correction-and-learning loop**: when a user corrects an agent (e.g. "no, that's wrong"), AgentRecall logs it, tracks whether the warning gets heeded next time, and counts recurrence. Every correction carries a `precision = heeded / retrieved` KPI — the only number that proves the system is actually learning, not just storing.

The user wants a **war-room style panel** that surfaces all of this state in one glance, **every time a session starts or ends**. Think Bloomberg terminal density, not Notion clean. Six panels visible at once on a 1440-wide screen, no tabs, no scrolling within panels for the primary state.

The user's stated visual preference: **beige / warm color palette base, round font (Nunito), side-by-side EN/ZH typography**. Inside chart panels, dark canvas for contrast — but the page frame / chrome stays beige.

---

## 2. Deliverable shape

**One file:** `dashboard.html` — self-contained, opens in any modern browser by double-clicking. No build step. No internet required after first vendor install.

**Library stack:**
- **Apache ECharts** (vendored to a sibling folder `./static/echarts.min.js`) — bar charts, line/spark, heatmaps, timelines
- **Cytoscape.js** (vendored to `./static/cytoscape.min.js`) — palace graph
- **Vanilla JS** for everything else. No React, no Vue, no bundler.
- **Nunito font** — pull from Google Fonts at the top OR vendor locally (your call)

**No backend.** Mock data is inlined in `<script>` at the top of the HTML. Real wiring (replacing the mock JSON with a `fetch('/dashboard.json')` poll) happens after design approval.

**Width target:** 1440-wide MacBook screen. Should also degrade gracefully at 1280 (laptop) and 1920 (external display). Below 1024 is out of scope.

---

## 3. Visual identity

### Palette

```css
:root {
  /* Beige/warm base — page frame, panels, headers */
  --bg:         #FAF7F0;   /* page background */
  --bg-soft:    #F1ECDD;   /* panel surface */
  --bg-strong:  #E6DFC5;   /* panel border / divider */
  --ink:        #2B2520;   /* primary text */
  --ink-soft:   #5A4E3F;   /* secondary text */

  /* Dark canvas inside chart panels for contrast */
  --canvas:     #1A1814;
  --canvas-line:#3A332B;
  --canvas-ink: #E8E0D0;

  /* Accents */
  --accent:     #8A6A3F;   /* warm amber — primary action / link */
  --accent-soft:#C9A56C;
  --ok:         #4F7A48;
  --warn:       #BD7C2D;
  --bad:        #B7472A;
  --rule:       #D9CDB0;
}
```

### Typography
- **Body / labels**: Nunito 400 + 600. Anti-aliased.
- **Monospace** (only for IDs, timestamps, file paths): `'JetBrains Mono', 'SF Mono', ui-monospace`.
- Base size 14px. Panel titles 12px uppercase, letterspacing .12em. Stat numbers 28-32px, font-weight 800.

### Density
- 8px grid system. Padding `12px 16px` inside panels. Gap between panels `12px`.
- Each panel has a 12px-tall header (`PANEL TITLE · subtitle`) then the canvas.
- No drop shadows beyond `0 1px 2px rgba(0,0,0,.04)` — flat, dense, fast-reading.

### Header strip (top of page)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  AgentRecall · War Room              2026-06-08 14:23  ● live · 1.2s ago   │
├────────────────────────────────────────────────────────────────────────────┤
```

Left: product name + subtitle. Right: ISO timestamp + "● live" pill + "Xs ago" since last data refresh. The pill turns red if data is > 30s stale.

### Footer status pill row (bottom of page)

```
[16 projects · 5 memory layers · 20 behavior rules · 14 skills · last save 14:21]
```

One row. Compact. No interaction.

---

## 4. The six panels (this is the meat)

Layout: 3 columns × 2 rows. Panel sizes equal. On 1440px wide: each panel ≈ 460×320 inside the gap-12 grid.

### Panel 1 — Project Map (top-left)
**Purpose:** what should I work on right now, across all 16 projects.

**Visualization:** three vertical columns inside the panel, one per zone (NEEDS YOU / BACKLOG / STALE). Each project = a card showing slug + last-updated date. Color-coded by zone (red / amber / grey). The 3 NEEDS YOU projects always visible; BACKLOG / STALE scroll within their column.

**Interaction:** hover a card → tooltip with one-line "Why" + "Blocked"/"Next". Click → no action in design pass (placeholder cursor).

**Mock data:** see §6 below.

### Panel 2 — Active Pipeline (top-center)
**Purpose:** where is the most-active project narratively. Single project view.

**Visualization:** vertical timeline. Top card = the currently-active phase (highlighted with `--accent`). Below it: last 2 closed phases collapsed into one-line synthesis cards. Phase shows: order, name, days open, goal.

**Interaction:** none in design pass.

### Panel 3 — Dream Health (top-right)
**Purpose:** is the background dream cron working.

**Visualization:** GitHub-style 14-cell heatmap, one cell per day, last 14 days left-to-right. Green = success, red = fail, grey = no run. Above the grid: "6 fails / 8 success" stat. Below: "⚠ last fail 2026-05-28" with a tiny warning icon if any failures in the last 7 days.

### Panel 4 — Correction Precision (middle-left) ⭐ HERO PANEL
**Purpose:** prove the system is learning. This is THE moat artifact.

**Visualization:** two stacked sub-panels.
- **Top half:** horizontal bar chart, one bar per correction (max 8 shown, sorted by retrieved_count desc). Each bar splits visually: `heeded` portion in `--ok` green, `retrieved` total in `--bg-strong`. Number label at end: `12/14 heeded · p=0.86`.
- **Bottom half:** single sparkline of `aggregate precision` over the last 30 saves. Show current value as a big number (`p = 0.84`) with an up/down arrow vs 30 saves ago.

This panel should feel like the most important thing on the screen. **Slightly larger numbers. Subtle pulse animation** on the current precision value when it updates.

### Panel 5 — Palace Graph (middle-center)
**Purpose:** show the shape of the project's semantic memory.

**Visualization:** **Cytoscape.js force-directed graph.** Nodes = palace rooms (Architecture, Goals, Blockers, Knowledge, etc.). Edges = `[[wikilinks]]` between rooms. Node size = salience (0–1 mapped to 12–36px diameter). Node color = recency (recent = `--accent`, stale = `--bg-strong`).

**Interaction:** drag nodes. Hover → tooltip with room name + last-updated date.

**Cap:** show top 12 rooms by salience. "+N more" badge if there are more.

### Panel 6 — Recent Activity (middle-right)
**Purpose:** what just happened (last 20 events).

**Visualization:** scrollable list, newest at top. Each row: `HH:MM` + event icon + 1-line description.
Event types and their icons:
- ✓ session_end (green check)
- ⚠ correction recorded (amber warning)
- ▶ pipeline phase opened (blue triangle)
- ■ pipeline phase closed (blue square)
- ✦ skill_write (purple sparkle)
- + insight promoted (teal plus)
- ✗ correction recurrence (red X — same bug came back after warning, this is the most important signal)

Auto-scroll to top on update.

---

## 5. Tech constraints

- **No React, no Vue, no Svelte, no bundler.** Vanilla JS + `<script>` tags only.
- **Two libs allowed:** ECharts + Cytoscape, both vendored to `./static/`.
- **Single HTML file** end-to-end. CSS inlined in `<style>`. JS inlined in `<script>`. No external CSS files.
- **Total file size target:** under 100 KB (excluding vendored libs).
- **Browsers:** modern evergreen (Chrome / Safari / Firefox latest). No IE / old Edge support.
- **No network requests after page load** — page must work fully offline.
- **No animations beyond:** subtle fade-in on data refresh (200ms), pulse on the hero precision number, force-layout settling on Cytoscape. No bouncy stuff.

---

## 6. Mock data (inline this in the HTML)

```javascript
const MOCK = {
  generated_at: "2026-06-08T14:23:00Z",
  projects: [
    // 3 NEEDS YOU
    { slug: "agentproxy", zone: "blocked", last: "2026-05-27",
      why: "Build novada-proxy into a production-grade proxy MCP tool",
      blocker: "June OKR: ship novada_get as default MCP tool (4 tools instead of 11)" },
    { slug: "apqc", zone: "blocked", last: "2026-05-21",
      why: "Build an agent-native APQC operating system",
      blocker: "Verify Settings GitHub card renders after hard refresh" },
    { slug: "novada-mcp", zone: "blocked", last: "2026-06-02",
      why: "Beat Firecrawl/BrightData/Tavily/Decodo on ≥5 buying dimensions",
      blocker: "Port hosted/worker → hosted/vercel Edge Function" },

    // 9 BACKLOG (sorted newest first)
    { slug: "prismma-gateway", zone: "active", last: "2026-06-08",
      why: "Ship Prismma — EU AI API relay for CN enterprises (GDPR moat)",
      next: "Review Linear KR-1 backlog (9 issues, INC-49 through INC-61)" },
    { slug: "plywood", zone: "active", last: "2026-06-07",
      why: "Compile natural language into structured pseudocode for agents",
      next: "Continue Loop 4 — scaffold uses unified preamble" },
    { slug: "xigu-ordering", zone: "active", last: "2026-06-05",
      why: "Restaurant ordering system with kitchen-display mode",
      next: "完成后厨屏 UI → 给店主演示完整流程" },
    { slug: "AgentRecall", zone: "active", last: "2026-06-02",
      why: "Correction-first persistent memory for AI agents",
      next: "Wire Hopfield to smart-recall.ts:528 after 3 prereqs" },
    { slug: "novada-intel", zone: "active", last: "2026-05-30",
      why: "Daily competitive intelligence pipeline",
      next: "Restart sender cron after Claude auth fixed" },
    { slug: "eu-ai-gateway", zone: "active", last: "2026-05-29",
      why: "EU AI API relay (Prismma) — German entity + GDPR moat",
      next: "Merged into prismma-gateway 2026-05-30" },
    { slug: "aam", zone: "active", last: "2026-05-26",
      why: "Overnight multi-agent orchestration harness",
      next: "Test scope gate with medium task" },
    { slug: "novada-proxy", zone: "active", last: "2026-05-25",
      why: "Complete Novada Proxy product ecosystem",
      next: "June OKR — apply remaining 20 audit items" },
    { slug: "prismma", zone: "active", last: "2026-05-21",
      why: "Launch prismma — Seedance 2.0 video gen API reseller",
      next: "Monitor deployment; when Volcano supports 2K, remove comingSoon" },

    // 4 STALE
    { slug: "novada-proxy-extension", zone: "stale", last: "2026-05-09",
      last_summary: "README improved 123 → 224 lines via AAM inline orchestration" },
    { slug: "novada-scraper", zone: "stale", last: "2026-04-17" },
    { slug: "novada-site", zone: "stale", last: "2026-04-23" },
    { slug: "novada-web", zone: "stale", last: "2026-04-23" },
  ],

  active_pipeline: {
    project: "prismma-gateway",
    current: {
      order: "H",
      phase: "Pre-launch Hardening",
      opened: "2026-06-01",
      days_open: 7,
      goal: "Close deferred risks before first paying customer."
    },
    recent_closed: [
      { order: "G", phase: "SSL Regression Fix",
        synthesis: "Cloudflare config is zone-wide unless explicitly scoped per-host." },
      { order: "F", phase: "Gateway Routing",
        synthesis: "Cloudflare 4-step (DNS+Proxy+OriginRule+SSL) is the standard pattern." },
    ]
  },

  dream_health: {
    last_14_days: [
      // newest first; "ok" | "fail" | "none"
      "ok","ok","ok","fail","fail","fail","fail","fail","fail","ok","ok","ok","ok","ok"
    ],
    success_count: 8,
    fail_count: 6,
    last_fail_date: "2026-05-28",
    last_success_date: "2026-06-08"
  },

  correction_precision: {
    aggregate_precision: 0.84,
    delta_30_saves: +0.07,            // trending up
    sparkline_30_saves: [0.71,0.72,0.70,0.74,0.75,0.76,0.74,0.78,0.79,0.79,0.80,0.81,0.79,0.82,0.83,0.83,0.81,0.82,0.84,0.84,0.83,0.85,0.84,0.83,0.85,0.84,0.83,0.84,0.84,0.84],
    top_corrections: [
      { rule: "Never push or publish without explicit approval",
        retrieved: 14, heeded: 12, recurred: 0, precision: 0.86 },
      { rule: "Always use canonical naming for memory files",
        retrieved: 11, heeded: 10, recurred: 0, precision: 0.91 },
      { rule: "Do not bump version numbers without explicit ask",
        retrieved: 9, heeded: 8, recurred: 1, precision: 0.89 },
      { rule: "Use Sonnet (not Opus) for routine coding tasks",
        retrieved: 7, heeded: 6, recurred: 0, precision: 0.86 },
      { rule: "Search GitHub before building from scratch",
        retrieved: 6, heeded: 4, recurred: 0, precision: 0.67 },
      { rule: "Paste arstatus board as text in chat reply",
        retrieved: 4, heeded: 4, recurred: 0, precision: 1.00 },
      { rule: "Trust observed reality over stated documentation",
        retrieved: 5, heeded: 2, recurred: 1, precision: 0.40 },
      { rule: "Don't map memory to human cognition slavishly",
        retrieved: 3, heeded: 2, recurred: 0, precision: 0.67 },
    ]
  },

  palace_graph: {
    project: "prismma-gateway",
    nodes: [
      { id: "Architecture", salience: 0.71, updated: "2026-06-08" },
      { id: "Goals",        salience: 0.69, updated: "2026-06-07" },
      { id: "Knowledge",    salience: 0.63, updated: "2026-06-05" },
      { id: "Predictions",  salience: 0.61, updated: "2026-05-30" },
      { id: "Alignment",    salience: 0.58, updated: "2026-06-01" },
      { id: "Blockers",     salience: 0.55, updated: "2026-06-02" },
      { id: "Decisions",    salience: 0.52, updated: "2026-05-29" },
      { id: "Identity",     salience: 0.48, updated: "2026-05-19" },
    ],
    edges: [
      { source: "Architecture", target: "Goals" },
      { source: "Architecture", target: "Decisions" },
      { source: "Goals",        target: "Blockers" },
      { source: "Goals",        target: "Alignment" },
      { source: "Knowledge",    target: "Architecture" },
      { source: "Knowledge",    target: "Predictions" },
      { source: "Alignment",    target: "Decisions" },
      { source: "Predictions",  target: "Blockers" },
      { source: "Identity",     target: "Goals" },
      { source: "Identity",     target: "Architecture" },
    ]
  },

  recent_activity: [
    { ts: "14:23", kind: "session_end",  desc: "AgentRecall session #21 saved (3 insights added)" },
    { ts: "14:21", kind: "correction",   desc: "P0: 'always paste arstatus board as TEXT in chat reply'" },
    { ts: "14:08", kind: "phase_open",   desc: "prismma-gateway · Phase H 'Pre-launch Hardening' opened" },
    { ts: "13:55", kind: "skill_write",  desc: "deploy / cloudflare-4step-pattern · trigger: cloudflare, dns" },
    { ts: "13:42", kind: "insight_promo",desc: "'Multi-loop subagent review catches silent-corruption bugs' (×3 confirmed)" },
    { ts: "13:30", kind: "phase_close",  desc: "prismma-gateway · Phase G 'SSL Regression Fix' closed · synthesis logged" },
    { ts: "13:15", kind: "session_end",  desc: "prismma-gateway session #19 saved" },
    { ts: "12:58", kind: "correction",   desc: "P1: 'Don't fabricate identifying facts — 'in formation' beats fake HRB'" },
    { ts: "12:42", kind: "recurrence",   desc: "⚠ 'Trust observed reality over stated docs' recurred (CLAUDE.md vs package.json)" },
    { ts: "12:20", kind: "session_end",  desc: "novada-mcp session #28 saved" },
    { ts: "12:01", kind: "skill_write",  desc: "git / rm-cached-untracked · trigger: git, untracked, history" },
    { ts: "11:48", kind: "correction",   desc: "P0: 'Use sanitizeProject not toSlug for any new write path'" },
    { ts: "11:30", kind: "insight_promo",desc: "'Auto-fill schema on explicit use beats migration paths' (×2 confirmed)" },
    { ts: "11:12", kind: "phase_open",   desc: "novada-mcp · Phase D 'Vercel Port' opened" },
    { ts: "10:55", kind: "session_end",  desc: "AgentRecall session #20 saved (release v3.4.21)" },
    { ts: "10:42", kind: "session_end",  desc: "plywood session #14 saved (Loop 4 in progress)" },
    { ts: "10:18", kind: "skill_write",  desc: "auth / oauth-refresh-precheck · trigger: oauth, refresh, expiry" },
    { ts: "09:55", kind: "correction",   desc: "P1: 'When using Edit tool, prefer `replace_all` for rename operations'" },
    { ts: "09:30", kind: "session_end",  desc: "xigu-ordering session #6 saved (kitchen-display UI iter)" },
    { ts: "09:08", kind: "phase_close",  desc: "AgentRecall · Phase 6 'Research-Driven Foundation' closed (shipped v3.4.21)" },
  ],

  footer_stats: {
    projects: 16,
    memory_layers: 5,
    behavior_rules: 20,
    skills: 14,
    last_save: "14:21"
  }
};
```

---

## 7. Out of scope (do NOT do these)

- ❌ Backend / WebSocket / SSE / daemon — pure static HTML only
- ❌ Authentication / login flows
- ❌ Editing UI (delete a correction, promote an insight, etc.) — display only
- ❌ Multi-user features
- ❌ Mobile responsive below 1024px
- ❌ Internationalization (the page is English-only in this pass; user's "side-by-side EN/ZH" preference applies to other AgentRecall surfaces, not this dashboard)
- ❌ Real fetch() to any URL — `MOCK` is the entire data source

---

## 8. Acceptance criteria

The deliverable passes if:

1. Opens by double-clicking `dashboard.html` in macOS Finder — no terminal, no installer
2. Works fully offline (no CDN requests after vendor install)
3. All 6 panels render real-looking content from the inlined `MOCK` data
4. Page renders cleanly at 1440px wide; degrades gracefully at 1280px
5. Palette / type matches the spec in §3
6. Cytoscape force layout settles within 2 seconds
7. No console errors or warnings
8. Single file ≤ 100 KB (excluding vendored libs)
9. Cmd+Shift+R hard reload still works (no service workers etc.)

---

## 9. Where to deliver

Save the result as:
- `~/Downloads/dashboard.html` (or wherever the user wants)
- Plus `./static/echarts.min.js` and `./static/cytoscape.min.js` alongside it

User will hand the folder back to the orchestrator Claude for wiring to real AgentRecall data.

---

## 10. Iteration

The orchestrator (the Claude that wrote this brief) will review your delivery and may send back specific change requests like:
- "Panel 4 needs the precision number 2x larger"
- "Switch the green to less saturated"
- "Palace graph nodes look too uniform — make salience differences more obvious"
- "Header row is too tall"

Expect 1-3 iteration rounds. Keep the file diffable — same structure each pass, comment your CSS variables, label your `<section>` blocks per panel.

---

## 11. One-paragraph summary if you only read this

Build a single offline HTML file that renders a 6-panel war-room dashboard for AgentRecall (an AI agent memory tool). The six panels are: project status map, active project pipeline, dream cron heatmap, **correction precision (the hero panel — make it beautiful)**, palace memory graph (Cytoscape), and recent activity feed. Palette: beige/warm frame + dark canvas inside chart panels, Nunito font, 8px grid, war-room density (no whitespace porn). Mock data is inlined. No backend, no React, no editing UI. The user wants something that feels like a Bloomberg terminal for their AI agents.
