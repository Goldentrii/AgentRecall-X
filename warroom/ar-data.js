/* ============================================================
   AgentRecall War Room — mock data (local-first, ~/.agent-recall)
   Everything here is illustrative. Timestamps are full precision.
============================================================ */
window.AR = (function () {

  var NOW = "2026-06-08T14:23:07";   // simulated "last save / now"

  /* ---- PROJECTS ---- */
  var projects = [
    {
      slug: "prismma-gateway", zone: "active", accent: "#8A6A3F",
      last: "2026-06-08T14:21:48",
      why: "Ship Prismma — EU AI API relay for CN enterprises (GDPR moat).",
      next: "Review Linear KR-1 backlog (9 issues, INC-49–INC-61).",
      rooms: 8, cards: 47, sessions: 19, rules: 6, skills: 5,
      prompt: "You are working on prismma-gateway. Before acting, recall Architecture + Goals. " +
              "Never push without explicit approval. Cloudflare changes are zone-wide unless scoped per-host. " +
              "Prefer observed reality (logs, responses) over stated docs.",
      learned: [
        "Cloudflare config is zone-wide unless explicitly scoped per-host.",
        "The 4-step pattern (DNS + Proxy + OriginRule + SSL) is the standard gateway setup.",
        "EU entity + data-residency is the actual moat — not the relay tech."
      ]
    },
    {
      slug: "AgentRecall", zone: "active", accent: "#4F7A48",
      last: "2026-06-02T19:42:11",
      why: "Correction-first persistent memory for AI agents.",
      next: "Wire Hopfield recall to smart-recall.ts:528 after 3 prereqs.",
      rooms: 9, cards: 63, sessions: 21, rules: 8, skills: 7,
      prompt: "You are working on AgentRecall itself. The moat is correction precision: " +
              "track whether corrections are retrieved AND heeded, and flag recurrences. " +
              "Use canonical naming (sanitizeProject, never toSlug) on any new write path.",
      learned: [
        "Recurrence is the only signal that proves the learning loop FAILED.",
        "Auto-fill schema on explicit use beats migration paths.",
        "Multi-loop subagent review catches silent-corruption bugs (confirmed ×3)."
      ]
    },
    {
      slug: "novada-mcp", zone: "blocked", accent: "#A85828",
      last: "2026-06-02T11:08:30",
      why: "Beat Firecrawl / BrightData / Tavily / Decodo on ≥5 buying dimensions.",
      blocker: "Port hosted/worker → hosted/vercel Edge Function (cold-start budget).",
      rooms: 7, cards: 38, sessions: 28, rules: 5, skills: 4,
      prompt: "You are working on novada-mcp. Benchmark against 4 named competitors on real " +
              "buying dimensions. Search GitHub before building anything from scratch.",
      learned: [
        "rm --cached untracked before history rewrites or you ship secrets.",
        "Edge cold-start is the gating constraint, not throughput."
      ]
    },
    { slug: "agentproxy", zone: "blocked", accent: "#A85828", last: "2026-05-27T16:30:00",
      why: "Build novada-proxy into a production-grade proxy MCP tool.",
      blocker: "June OKR: ship novada_get as default MCP tool (4 tools, not 11).",
      rooms: 5, cards: 22, sessions: 12, rules: 4, skills: 3, prompt: "", learned: [] },
    { slug: "apqc", zone: "blocked", accent: "#A85828", last: "2026-05-21T10:12:00",
      why: "Build an agent-native APQC operating system.",
      blocker: "Verify Settings GitHub card renders after hard refresh.",
      rooms: 6, cards: 31, sessions: 9, rules: 5, skills: 2, prompt: "", learned: [] },
    { slug: "plywood", zone: "active", accent: "#8B5CB8", last: "2026-06-07T13:55:20",
      why: "Compile natural language into structured pseudocode for agents.",
      next: "Continue Loop 4 — scaffold uses unified preamble.",
      rooms: 6, cards: 29, sessions: 14, rules: 4, skills: 4, prompt: "", learned: [] },
    { slug: "xigu-ordering", zone: "active", accent: "#3A9B8A", last: "2026-06-05T21:18:00",
      why: "Restaurant ordering system with kitchen-display mode.",
      next: "完成后厨屏 UI → 给店主演示完整流程.",
      rooms: 4, cards: 18, sessions: 6, rules: 3, skills: 2, prompt: "", learned: [] },
    { slug: "novada-intel", zone: "active", accent: "#5B8DB8", last: "2026-05-30T08:44:00",
      why: "Daily competitive intelligence pipeline.",
      next: "Restart sender cron after Claude auth fixed.",
      rooms: 5, cards: 24, sessions: 11, rules: 4, skills: 3, prompt: "", learned: [] },
    { slug: "aam", zone: "active", accent: "#BD7C2D", last: "2026-05-26T17:02:00",
      why: "Overnight multi-agent orchestration harness.",
      next: "Test scope gate with medium task.",
      rooms: 5, cards: 26, sessions: 13, rules: 5, skills: 4, prompt: "", learned: [] },
    { slug: "prismma", zone: "active", accent: "#8B5CB8", last: "2026-05-21T12:30:00",
      why: "Launch prismma — Seedance 2.0 video-gen API reseller.",
      next: "When Volcano supports 2K, remove comingSoon flag.",
      rooms: 4, cards: 16, sessions: 8, rules: 3, skills: 2, prompt: "", learned: [] },
    { slug: "novada-proxy-extension", zone: "stale", accent: "#8C7F6B", last: "2026-05-09T09:00:00",
      why: "Browser extension for Novada Proxy.",
      note: "README improved 123 → 224 lines via AAM inline orchestration.",
      rooms: 3, cards: 9, sessions: 4, rules: 2, skills: 1, prompt: "", learned: [] },
    { slug: "novada-scraper", zone: "stale", accent: "#8C7F6B", last: "2026-04-17T14:00:00",
      why: "Scraper toolkit.", rooms: 3, cards: 7, sessions: 3, rules: 1, skills: 1, prompt: "", learned: [] },
    { slug: "novada-site", zone: "stale", accent: "#8C7F6B", last: "2026-04-23T11:00:00",
      why: "Marketing site.", rooms: 2, cards: 5, sessions: 2, rules: 1, skills: 0, prompt: "", learned: [] },
    { slug: "novada-web", zone: "stale", accent: "#8C7F6B", last: "2026-04-23T11:30:00",
      why: "Web app shell.", rooms: 2, cards: 6, sessions: 2, rules: 1, skills: 0, prompt: "", learned: [] },
  ];

  /* ---- ROOMS (memory palace) per project ---- */
  var rooms = {
    "prismma-gateway": [
      { id: "Architecture", salience: 0.71, cards: 11, updated: "2026-06-08T14:21:48" },
      { id: "Goals",        salience: 0.69, cards: 8,  updated: "2026-06-07T18:02:00" },
      { id: "Knowledge",    salience: 0.63, cards: 9,  updated: "2026-06-05T12:30:00" },
      { id: "Predictions",  salience: 0.61, cards: 4,  updated: "2026-05-30T09:10:00" },
      { id: "Alignment",    salience: 0.58, cards: 5,  updated: "2026-06-01T11:00:00" },
      { id: "Blockers",     salience: 0.55, cards: 3,  updated: "2026-06-02T16:40:00" },
      { id: "Decisions",    salience: 0.52, cards: 5,  updated: "2026-05-29T14:00:00" },
      { id: "Identity",     salience: 0.48, cards: 2,  updated: "2026-05-19T10:00:00" },
    ],
    "AgentRecall": [
      { id: "Architecture", salience: 0.78, cards: 14, updated: "2026-06-02T19:42:11" },
      { id: "Goals",        salience: 0.66, cards: 9,  updated: "2026-06-01T10:00:00" },
      { id: "Knowledge",    salience: 0.70, cards: 12, updated: "2026-06-02T17:00:00" },
      { id: "Predictions",  salience: 0.55, cards: 6,  updated: "2026-05-28T09:00:00" },
      { id: "Alignment",    salience: 0.62, cards: 7,  updated: "2026-05-30T14:00:00" },
      { id: "Blockers",     salience: 0.50, cards: 4,  updated: "2026-06-01T16:00:00" },
      { id: "Decisions",    salience: 0.60, cards: 7,  updated: "2026-05-31T11:00:00" },
      { id: "Identity",     salience: 0.45, cards: 2,  updated: "2026-05-15T10:00:00" },
      { id: "Patterns",     salience: 0.58, cards: 2,  updated: "2026-05-27T13:00:00" },
    ],
  };

  /* ---- MEMORY CARDS (sample, keyed by project) ---- */
  var cards = {
    "prismma-gateway": [
      { room: "Architecture", title: "Cloudflare 4-step routing", created: "2026-06-08T14:21:48",
        body: "Gateway = DNS record + orange-cloud proxy + Origin Rule (host header) + SSL mode 'Full (strict)'. Miss any one and you get a 525/1014." },
      { room: "Knowledge", title: "SSL is zone-wide", created: "2026-06-05T12:30:00",
        body: "SSL/TLS mode applies to the whole zone unless you add a per-hostname Edge Certificate. Scoping per-host requires a Page Rule or Config Rule." },
      { room: "Goals", title: "First paying customer gate", created: "2026-06-07T18:02:00",
        body: "Do not invite the first paying customer until Phase H (Pre-launch Hardening) closes. Deferred-risk list must be empty." },
      { room: "Blockers", title: "INC-49 — EU residency proof", created: "2026-06-02T16:40:00",
        body: "Need signed data-residency attestation before onboarding German entity. Legal owns; blocked on their template." },
    ],
    "AgentRecall": [
      { room: "Architecture", title: "Correction precision formula", created: "2026-06-02T19:42:11",
        body: "precision = heeded / retrieved. Recurrence (heeded once, broke again) is tracked separately — it is the only proof the loop FAILED." },
      { room: "Knowledge", title: "Canonical naming", created: "2026-06-01T13:00:00",
        body: "Always sanitizeProject() on write paths. toSlug() is lossy and collides on unicode project names (e.g. 西谷)." },
      { room: "Patterns", title: "Multi-loop subagent review", created: "2026-05-27T13:00:00",
        body: "Running 3 independent review passes catches silent-corruption bugs a single pass misses. Confirmed on the activity-panel concat bug." },
    ],
  };

  /* ---- MILESTONES per project (errors vs improvements vs changes) ---- */
  var milestones = {
    "prismma-gateway": [
      { ts: "2026-06-08T14:21:48", kind: "improvement", actor: "agent", title: "Phase H opened — pre-launch hardening",
        detail: "Agent closed Phase G (SSL) and opened H after you approved the deferred-risk list." },
      { ts: "2026-06-07T18:02:00", kind: "change", actor: "you", title: "Reordered KR-1 backlog",
        detail: "You moved INC-49 (EU residency) above INC-53. Agent updated Goals room." },
      { ts: "2026-06-05T12:34:00", kind: "error", actor: "agent", title: "525 handshake on api.prismma.eu",
        detail: "Agent set SSL to 'Flexible' zone-wide — broke 3 other hosts. You corrected → 'Full (strict)'." },
      { ts: "2026-06-05T12:48:00", kind: "improvement", actor: "agent", title: "Logged SSL zone-wide rule",
        detail: "After your correction the agent wrote the 'SSL is zone-wide' card so it won't recur." },
      { ts: "2026-06-01T11:00:00", kind: "change", actor: "agent", title: "Alignment room refreshed",
        detail: "Synced 5 alignment cards with the new GDPR positioning." },
    ],
    "AgentRecall": [
      { ts: "2026-06-02T19:42:11", kind: "improvement", actor: "agent", title: "Session #21 saved (+3 insights)",
        detail: "Promoted 'multi-loop review catches corruption' to a confirmed pattern." },
      { ts: "2026-06-02T12:42:00", kind: "error", actor: "agent", title: "Recurrence: trust observed reality",
        detail: "Agent trusted package.json over the running build again (recurred ×1). You re-corrected." },
      { ts: "2026-06-01T13:00:00", kind: "change", actor: "you", title: "Renamed write path helper",
        detail: "You enforced sanitizeProject over toSlug. Agent updated Knowledge room + behavior rule." },
    ],
  };

  /* ---- ACTIVITY (full-precision timestamps, newest first) ---- */
  var activity = [
    { ts: "2026-06-08T14:23:07", kind: "session_end",   project: "AgentRecall",      desc: "session #21 saved (3 insights added)" },
    { ts: "2026-06-08T14:21:48", kind: "correction",    project: "AgentRecall",      desc: "P0: always paste arstatus board as TEXT in chat reply" },
    { ts: "2026-06-08T14:08:33", kind: "phase_open",    project: "prismma-gateway",  desc: "Phase H 'Pre-launch Hardening' opened" },
    { ts: "2026-06-08T13:55:02", kind: "skill_write",   project: "prismma-gateway",  desc: "deploy / cloudflare-4step-pattern · trigger: cloudflare, dns" },
    { ts: "2026-06-08T13:42:19", kind: "insight",       project: "AgentRecall",      desc: "'Multi-loop subagent review catches silent-corruption bugs' (×3)" },
    { ts: "2026-06-08T13:30:55", kind: "phase_close",   project: "prismma-gateway",  desc: "Phase G 'SSL Regression Fix' closed · synthesis logged" },
    { ts: "2026-06-08T13:15:41", kind: "session_end",   project: "prismma-gateway",  desc: "session #19 saved" },
    { ts: "2026-06-08T12:58:12", kind: "correction",    project: "novada-mcp",       desc: "P1: don't fabricate identifying facts — info beats fake HRB" },
    { ts: "2026-06-08T12:42:30", kind: "recurrence",    project: "AgentRecall",      desc: "'Trust observed reality over stated docs' recurred (CLAUDE.md vs package.json)" },
    { ts: "2026-06-08T12:20:08", kind: "session_end",   project: "novada-mcp",       desc: "session #28 saved" },
    { ts: "2026-06-08T12:01:44", kind: "skill_write",   project: "novada-mcp",       desc: "git / rm-cached-untracked · trigger: git, untracked, history" },
    { ts: "2026-06-08T11:48:55", kind: "correction",    project: "AgentRecall",      desc: "P0: use sanitizeProject not toSlug for any new write path" },
    { ts: "2026-06-08T11:30:17", kind: "insight",       project: "AgentRecall",      desc: "'Auto-fill schema on explicit use beats migration paths' (×2 confirmed)" },
    { ts: "2026-06-08T11:12:03", kind: "phase_open",    project: "novada-mcp",       desc: "Phase D 'Vercel Port' opened" },
    { ts: "2026-06-08T10:55:38", kind: "session_end",   project: "AgentRecall",      desc: "session #20 saved (release v3.4.21)" },
    { ts: "2026-06-08T10:42:51", kind: "session_end",   project: "plywood",          desc: "session #14 saved (Loop 4 in progress)" },
    { ts: "2026-06-08T10:18:22", kind: "skill_write",   project: "prismma-gateway",  desc: "auth / oauth-refresh-precheck · trigger: oauth, refresh, expiry" },
    { ts: "2026-06-08T09:55:09", kind: "correction",    project: "plywood",          desc: "P1: when using Edit tool, prefer replace_all for renames" },
    { ts: "2026-06-08T09:30:47", kind: "session_end",   project: "xigu-ordering",    desc: "session #6 saved (kitchen-display UI iter)" },
    { ts: "2026-06-08T09:08:14", kind: "phase_close",   project: "AgentRecall",      desc: "Phase 6 'Research-Driven Foundation' closed (shipped v3.4.21)" },
  ];

  /* ---- ACTIVITY CALENDAR — 18 weeks of daily save counts (deterministic) ---- */
  function buildCalendar() {
    var weeks = 18, days = weeks * 7;
    var end = new Date(NOW); end.setHours(0, 0, 0, 0);
    var out = [];
    var seed = 1337;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(end); d.setDate(d.getDate() - i);
      var dow = d.getDay();
      var r = rnd();
      var base = (dow === 0 || dow === 6) ? r * 8 : r * 26;     // weekends quieter
      var recent = i < 21 ? 6 : 0;                               // ramp recently
      var count = Math.max(0, Math.round(base + recent - (r < 0.12 ? base : 0)));
      out.push({ date: d.toISOString().slice(0, 10), count: count, dow: dow });
    }
    return out;
  }

  /* ---- DREAM RUNS (background consolidation cron) ---- */
  var dreams = [
    { date: "2026-06-08", status: "ok",   project: "prismma-gateway", started: "03:14:02", dur: "0:48",
      summary: "Consolidated 9 cards, promoted 1 pattern, pruned 2 stale predictions.",
      files: ["~/.agent-recall/prismma-gateway/architecture.md", "~/.agent-recall/prismma-gateway/knowledge.md", "~/.agent-recall/_index/salience.json"] },
    { date: "2026-06-07", status: "ok",   project: "AgentRecall", started: "03:12:55", dur: "1:02",
      summary: "Merged 3 duplicate insight cards, recomputed salience for 14 rooms.",
      files: ["~/.agent-recall/AgentRecall/knowledge.md", "~/.agent-recall/_index/salience.json"] },
    { date: "2026-06-06", status: "ok",   project: "novada-mcp", started: "03:15:31", dur: "0:39",
      summary: "No structural changes; refreshed 4 embeddings.",
      files: ["~/.agent-recall/_index/embeddings.bin"] },
    { date: "2026-06-05", status: "ok",   project: "prismma-gateway", started: "03:13:08", dur: "0:51",
      summary: "Linked SSL card to Blockers room.", files: ["~/.agent-recall/prismma-gateway/knowledge.md"] },
    { date: "2026-06-04", status: "ok",   project: "plywood", started: "03:11:44", dur: "0:33",
      summary: "Pruned 1 expired prediction.", files: ["~/.agent-recall/plywood/predictions.md"] },
    { date: "2026-06-03", status: "ok",   project: "AgentRecall", started: "03:14:19", dur: "0:57",
      summary: "Promoted 2 insights to confirmed patterns.", files: ["~/.agent-recall/AgentRecall/patterns.md"] },
    { date: "2026-06-02", status: "ok",   project: "novada-intel", started: "03:12:02", dur: "0:41",
      summary: "Routine consolidation.", files: ["~/.agent-recall/novada-intel/knowledge.md"] },
    { date: "2026-06-01", status: "ok",   project: "prismma-gateway", started: "03:13:50", dur: "0:46",
      summary: "Refreshed alignment cards.", files: ["~/.agent-recall/prismma-gateway/alignment.md"] },
    { date: "2026-05-31", status: "ok",   project: "AgentRecall", started: "03:15:00", dur: "0:52", summary: "Routine.", files: [] },
    { date: "2026-05-30", status: "ok",   project: "prismma-gateway", started: "03:12:40", dur: "0:38", summary: "Routine.", files: [] },
    { date: "2026-05-29", status: "ok",   project: "aam", started: "03:14:11", dur: "0:44", summary: "Routine.", files: [] },
    { date: "2026-05-28", status: "fail", project: "novada-mcp", started: "03:13:22", dur: "0:09",
      summary: "Embedding index lock not released — cron aborted. Stale lock at _index/.lock.",
      files: ["~/.agent-recall/_index/.lock", "~/.agent-recall/_logs/dream-2026-05-28.log"] },
    { date: "2026-05-27", status: "fail", project: "novada-mcp", started: "03:13:05", dur: "0:07",
      summary: "Same lock — retry also aborted.", files: ["~/.agent-recall/_logs/dream-2026-05-27.log"] },
    { date: "2026-05-26", status: "fail", project: "novada-mcp", started: "03:14:48", dur: "0:08",
      summary: "Lock contention with manual reindex.", files: ["~/.agent-recall/_logs/dream-2026-05-26.log"] },
    { date: "2026-05-25", status: "fail", project: "prismma-gateway", started: "03:12:19", dur: "0:11",
      summary: "Disk full on /tmp during merge.", files: ["~/.agent-recall/_logs/dream-2026-05-25.log"] },
    { date: "2026-05-24", status: "fail", project: "AgentRecall", started: "03:13:37", dur: "0:06",
      summary: "Disk full — same root cause.", files: ["~/.agent-recall/_logs/dream-2026-05-24.log"] },
    { date: "2026-05-23", status: "fail", project: "plywood", started: "03:15:12", dur: "0:10",
      summary: "Disk full — cleared /tmp afterward.", files: ["~/.agent-recall/_logs/dream-2026-05-23.log"] },
    { date: "2026-05-22", status: "ok",   project: "prismma-gateway", started: "03:12:58", dur: "0:43", summary: "Routine.", files: [] },
    { date: "2026-05-21", status: "ok",   project: "novada-mcp", started: "03:14:02", dur: "0:40", summary: "Routine.", files: [] },
    { date: "2026-05-20", status: "ok",   project: "AgentRecall", started: "03:13:25", dur: "0:49", summary: "Routine.", files: [] },
  ];

  /* ---- CORRECTION PRECISION (kept, but secondary now) ---- */
  var precision = {
    aggregate_pct: 84, delta_pts: 7,
    spark: [0.71,0.72,0.70,0.74,0.75,0.76,0.74,0.78,0.79,0.79,0.80,0.81,0.79,0.82,0.83,0.83,0.81,0.82,0.84,0.84,0.83,0.85,0.84,0.83,0.85,0.84,0.83,0.84,0.84,0.84],
    rules: [
      { rule: "Never push or publish without explicit approval", retrieved: 14, heeded: 12, recurred: 0, precision: 0.86 },
      { rule: "Always use canonical naming for memory files",    retrieved: 11, heeded: 10, recurred: 0, precision: 0.91 },
      { rule: "Do not bump version numbers without explicit ask", retrieved: 9, heeded: 8, recurred: 1, precision: 0.89 },
      { rule: "Use Sonnet (not Opus) for routine coding tasks",  retrieved: 7, heeded: 6, recurred: 0, precision: 0.86 },
      { rule: "Search GitHub before building from scratch",      retrieved: 6, heeded: 4, recurred: 0, precision: 0.67 },
      { rule: "Trust observed reality over stated documentation", retrieved: 5, heeded: 2, recurred: 1, precision: 0.40 },
    ]
  };

  /* ---- PALACE GRAPH (cross-project, node-type variety) ---- */
  var palace = {
    legend: [
      { type: "Architecture", color: "#C9A56C" },
      { type: "Knowledge",    color: "#5B8DB8" },
      { type: "Goals",        color: "#4F7A48" },
      { type: "Decisions",    color: "#8B5CB8" },
      { type: "Blockers",     color: "#A85828" },
      { type: "Pattern",      color: "#3A9B8A" },
    ],
    nodes: [
      { id: "Architecture", type: "Architecture", salience: 0.71, cards: 11, project: "prismma-gateway", updated: "2026-06-08" },
      { id: "Goals",        type: "Goals",        salience: 0.69, cards: 8,  project: "prismma-gateway", updated: "2026-06-07" },
      { id: "Knowledge",    type: "Knowledge",    salience: 0.63, cards: 9,  project: "prismma-gateway", updated: "2026-06-05" },
      { id: "Predictions",  type: "Knowledge",    salience: 0.61, cards: 4,  project: "prismma-gateway", updated: "2026-05-30" },
      { id: "Alignment",    type: "Goals",        salience: 0.58, cards: 5,  project: "prismma-gateway", updated: "2026-06-01" },
      { id: "Blockers",     type: "Blockers",     salience: 0.55, cards: 3,  project: "prismma-gateway", updated: "2026-06-02" },
      { id: "Decisions",    type: "Decisions",    salience: 0.52, cards: 5,  project: "prismma-gateway", updated: "2026-05-29" },
      { id: "Identity",     type: "Pattern",      salience: 0.48, cards: 2,  project: "prismma-gateway", updated: "2026-05-19" },
    ],
    edges: [
      ["Architecture","Goals"], ["Architecture","Decisions"], ["Goals","Blockers"],
      ["Goals","Alignment"], ["Knowledge","Architecture"], ["Knowledge","Predictions"],
      ["Alignment","Decisions"], ["Predictions","Blockers"], ["Identity","Goals"], ["Identity","Architecture"],
    ]
  };

  /* ---- ONBOARDING clients ----
     compat: 'verified' | 'pattern' | 'unverified' | 'no-mcp'
     verified  = tested end-to-end
     pattern   = protocol-equivalent, works in practice
     unverified = MCP-compatible but not formally tested
     no-mcp    = no MCP support; workaround provided
  ---- */
  var clients = [
    { name: "Claude Code", compat: "verified",
      blurb: "Anthropic's official terminal agent — native MCP, one-line install.",
      brand: "CC", si: "anthropic",
      pre: "node -v  # Node 18+ required",
      install: "claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp",
      verify: "Restart claude, run /mcp — agent-recall · 5 tools. Append --full to unlock all 22." },

    { name: "Claude Desktop", compat: "verified",
      blurb: "Anthropic desktop app — native MCP, edit claude_desktop_config.json.",
      brand: "CD", si: "anthropic",
      pre: "Open ~/Library/Application Support/Claude/claude_desktop_config.json  (Mac)",
      install: "\"agent-recall\": { \"command\": \"npx\", \"args\": [\"-y\",\"agent-recall-mcp\"] }",
      verify: "Restart Claude Desktop. The 🔌 icon should list agent-recall with 5 tools." },

    { name: "Cursor", compat: "verified",
      blurb: "AI-native IDE — native MCP via .cursor/mcp.json in your project.",
      brand: "Cu", si: "cursor",
      pre: "Create or open .cursor/mcp.json",
      install: "{ \"mcpServers\": { \"agent-recall\": { \"command\": \"npx\", \"args\": [\"-y\",\"agent-recall-mcp\"] } } }",
      verify: "Settings → MCP → agent-recall connected." },

    { name: "VS Code", compat: "verified",
      blurb: "VS Code 1.99+ Copilot agent mode. Key is 'servers', not 'mcpServers'.",
      brand: "VS", si: "visualstudiocode",
      pre: "Create .vscode/mcp.json in your workspace",
      install: "{ \"servers\": { \"agent-recall\": { \"command\": \"npx\", \"args\": [\"-y\",\"agent-recall-mcp\"] } } }",
      verify: "Reload window; MCP: List Servers shows agent-recall." },

    { name: "Codex CLI", compat: "verified",
      blurb: "OpenAI's terminal agent — MCP via ~/.codex/config.json.",
      brand: "Cx", si: "openai",
      pre: "Open or create ~/.codex/config.json",
      install: "{ \"mcpServers\": { \"agent-recall\": { \"command\": \"npx\", \"args\": [\"-y\",\"agent-recall-mcp\"] } } }",
      verify: "Restart codex; confirm MCP tools load at session start." },

    { name: "Gemini CLI", compat: "unverified",
      blurb: "Google's terminal agent — standard MCP config, community-reported working.",
      brand: "Gm", si: "googlegemini",
      pre: "Open ~/.gemini/settings.json",
      install: "{ \"mcpServers\": { \"agent-recall\": { \"command\": \"npx\", \"args\": [\"-y\",\"agent-recall-mcp\"] } } }",
      verify: "Restart Gemini CLI; verify MCP tools are loaded in session context." },

    { name: "Windsurf", compat: "verified",
      blurb: "Codeium's AI IDE — MCP via Windsurf settings.",
      brand: "Ws", si: "windsurf",
      pre: "Open Windsurf → Settings → MCP Servers",
      install: "{ \"mcpServers\": { \"agent-recall\": { \"command\": \"npx\", \"args\": [\"-y\",\"agent-recall-mcp\"] } } }",
      verify: "Reload Windsurf; AI assistant panel shows agent-recall connected." },

    { name: "Zed", compat: "verified",
      blurb: "GPU-accelerated editor — MCP via ~/.config/zed/settings.json (global).",
      brand: "Zd", si: "zedindustries",
      pre: "Open ~/.config/zed/settings.json",
      install: "{ \"context_servers\": { \"agent-recall\": { \"command\": { \"path\": \"npx\", \"args\": [\"-y\",\"agent-recall-mcp\"] } } } }",
      verify: "Restart Zed; context server appears in AI assistant panel." },

    { name: "Continue.dev", compat: "verified",
      blurb: "Open-source VS Code / JetBrains copilot — MCP in ~/.continue/config.yaml.",
      brand: "Co",
      pre: "Open ~/.continue/config.yaml",
      install: "mcpServers:\n  - name: agent-recall\n    command: npx -y agent-recall-mcp",
      verify: "Reload extension; MCP tools panel shows agent-recall." },

    { name: "Cline", compat: "verified",
      blurb: "VS Code extension — MCP servers configurable via Cline settings panel.",
      brand: "Cn", si: "cline",
      pre: "VS Code → Extensions → Cline → Settings → MCP Servers",
      install: "{ \"agent-recall\": { \"command\": \"npx\", \"args\": [\"-y\",\"agent-recall-mcp\"] } }",
      verify: "Cline sidebar MCP section shows agent-recall with 5 tools." },

    { name: "OpenCode", compat: "verified",
      blurb: "Terminal agent — MCP via ~/.config/opencode/config.json.",
      brand: "OC", si: "opencode",
      pre: "Open ~/.config/opencode/config.json",
      install: "{ \"mcp\": { \"agent-recall\": { \"type\": \"local\", \"command\": [\"npx\",\"-y\",\"agent-recall-mcp\"] } } }",
      verify: "Restart opencode; run /mcp to confirm agent-recall is listed." },

    { name: "Aider", compat: "no-mcp",
      blurb: "No native MCP — use the bootstrap prompt as a system prompt in .aider.conf.yml.",
      brand: "Ai",
      compatNote: "Aider doesn't support MCP. Add the bootstrap prompt below as --system-prompt.",
      pre: "Create or open .aider.conf.yml in your project root",
      install: "system-prompt: |\n  You have AgentRecall context. [paste bootstrap prompt below]",
      verify: "Run aider — system prompt is loaded. Memory is manual via convention." },

    { name: "Hermes (OpenClaw)", compat: "pattern",
      blurb: "NousResearch agent using OpenClaw protocol — compatible with agent-recall-mcp.",
      brand: "He", si: "hermes",
      compatNote: "Hermes implements the OpenClaw MCP protocol. AgentRecall tools function equivalently without modification.",
      pre: "Ensure openclaw agent is running",
      install: "openclaw mcp add agent-recall npx -y agent-recall-mcp",
      verify: "Check tool list in Hermes agent panel — session_start should appear." },
  ];

  /* bootstrap prompt — paste into your agent AFTER installing */
  var BOOTSTRAP_PROMPT =
"You have AgentRecall (persistent memory MCP). " +
"At the START of every session call session_start to load what you learned before. " +
"When the user corrects you, call remember({type:\"correction\",...}) immediately so it never recurs. " +
"At the END of every session call session_end. " +
"Five core tools: session_start, session_end, remember, recall, check. " +
"Memory lives in ~/.agent-recall and never leaves this machine unless sync is enabled.";

  /* install prompt — what to paste to tell your agent to INSTALL AgentRecall */
  var INSTALL_PROMPT =
"Please install AgentRecall for me — it's a persistent memory MCP that remembers corrections and context across sessions.\n\n" +
"For Claude Code (one command):\n" +
"  claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp\n\n" +
"For other clients, add to your MCP config:\n" +
"  { \"agent-recall\": { \"command\": \"npx\", \"args\": [\"-y\", \"agent-recall-mcp\"] } }\n\n" +
"After installing, restart your client and confirm agent-recall appears with 5 tools.\n" +
"Full setup guide: https://github.com/Goldentrii/AgentRecall#quick-start--快速开始";

  return {
    now: NOW,
    projects: projects,
    rooms: rooms,
    cards: cards,
    milestones: milestones,
    activity: activity,
    calendar: buildCalendar(),
    dreams: dreams,
    precision: precision,
    palace: palace,
    clients: clients,
    pastePrompt: BOOTSTRAP_PROMPT,
    installPrompt: INSTALL_PROMPT,
    stats: { projects: 16, memory_layers: 5, rules: 20, skills: 14, last_save: "14:21:48",
             last_save_path: "~/.agent-recall/AgentRecall/sessions/021.md" },
    byslug: function (s) { for (var i = 0; i < projects.length; i++) if (projects[i].slug === s) return projects[i]; return null; }
  };
})();
