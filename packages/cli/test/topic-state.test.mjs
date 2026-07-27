// packages/cli/test/topic-state.test.mjs
//
// Jarvis ambient recall — rolling session topic profile.
//
// Problem: hook-ambient's recall query used to be built ONLY from the current
// prompt's own keywords. A user who spends several turns giving background
// ("we're migrating the billing service... Postgres schema is the tricky
// part...") then asks a short generic follow-up ("what should I watch out
// for?") got NO ambient recall on that final prompt — its own keywords are
// too weak, even though the conversation's topic is clear by then.
//
// This file tests packages/cli/src/utils/topic-state.ts (pure module, unit
// tests against the compiled dist output) AND the end-to-end wiring inside
// hook-ambient (CLI spawn tests), covering every scenario the work package
// asked for:
//   1. profile accumulation across simulated prompts
//   2. decay
//   3. background-then-generic-question end-to-end (fires a recall the bare
//      prompt wouldn't)
//   4. precision guard (an unrelated new topic doesn't drag old-profile
//      injections into an unrelated conversation)
//   5. staleness sweep (both the 24h per-file staleness check and the 7d
//      opportunistic sibling sweep)
//   6. CJK background text building profile terms

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  extractTopicKeywords,
  loadProfile,
  computeDecayedProfile,
  appendTurn,
  profileOnlyTerms,
  topicQuery,
  topicStateFile,
  sweepStaleProfiles,
} from "../dist/utils/topic-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");

const cleanupRoots = [];
function freshRoot(label) {
  const root = path.join(os.tmpdir(), `ar-topic-state-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cleanupRoots.push(root);
  return root;
}

after(() => {
  for (const root of cleanupRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Run a hook command with the given stdin string. Returns {code, stdout, stderr}. */
function runHook(root, args, stdinPayload) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, "--root", root, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(stdinPayload ?? "");
    child.stdin.end();
  });
}

function buildStdin(prompt, sessionId) {
  return JSON.stringify({ prompt, session_id: sessionId });
}

// ── 1. Profile accumulation across simulated prompts ──────────────────────

describe("topic-state: profile accumulation across simulated prompts", () => {
  it("appendTurn persists turns in order and loadProfile reads them back", () => {
    const root = freshRoot("accum");
    appendTurn(root, "sess-1", ["alpha", "beta"]);
    appendTurn(root, "sess-1", ["beta", "gamma"]);
    const loaded = loadProfile(root, "sess-1");
    assert.ok(loaded, "profile must exist after two appends");
    assert.equal(loaded.turns.length, 2);
    assert.deepEqual(loaded.turns[0].keywords, ["alpha", "beta"]);
    assert.deepEqual(loaded.turns[1].keywords, ["beta", "gamma"]);
    assert.equal(loaded.turns[0].turn, 1);
    assert.equal(loaded.turns[1].turn, 2);
  });

  it("rolling window is capped at the last 8 turns (MAX_TURNS)", () => {
    const root = freshRoot("window-cap");
    for (let i = 1; i <= 10; i++) {
      appendTurn(root, "sess-cap", [`turn${i}`]);
    }
    const loaded = loadProfile(root, "sess-cap");
    assert.equal(loaded.turns.length, 8, "must cap at 8 turns even after 10 appends");
    // Oldest two turns (turn1, turn2) must have been dropped; turn3..turn10 remain
    const keywordSet = new Set(loaded.turns.flatMap((t) => t.keywords));
    assert.ok(!keywordSet.has("turn1"), "turn1 must have aged out of the window");
    assert.ok(!keywordSet.has("turn2"), "turn2 must have aged out of the window");
    assert.ok(keywordSet.has("turn10"), "turn10 (most recent) must still be present");
  });

  it("separate session keys accumulate independent profiles", () => {
    const root = freshRoot("independent");
    appendTurn(root, "sess-x", ["xterm"]);
    appendTurn(root, "sess-y", ["yterm"]);
    const x = loadProfile(root, "sess-x");
    const y = loadProfile(root, "sess-y");
    assert.deepEqual(x.turns.map((t) => t.keywords).flat(), ["xterm"]);
    assert.deepEqual(y.turns.map((t) => t.keywords).flat(), ["yterm"]);
  });
});

// ── 2. Decay ────────────────────────────────────────────────────────────────

describe("topic-state: decayed frequency map", () => {
  it("newest turn gets weight 1.0, older turns decay by 0.65^distance", () => {
    const turns = [
      { turn: 1, keywords: ["old"] },
      { turn: 2, keywords: ["mid"] },
      { turn: 3, keywords: ["new"] },
    ];
    const map = computeDecayedProfile(turns);
    assert.ok(Math.abs(map.get("new") - 1.0) < 1e-9, `newest term must be weight 1.0, got ${map.get("new")}`);
    assert.ok(Math.abs(map.get("mid") - 0.65) < 1e-9, `distance-1 term must be weight 0.65, got ${map.get("mid")}`);
    assert.ok(Math.abs(map.get("old") - 0.65 * 0.65) < 1e-9, `distance-2 term must be weight 0.4225, got ${map.get("old")}`);
  });

  it("a term recurring across turns accumulates weight from every occurrence", () => {
    const turns = [
      { turn: 1, keywords: ["postgres", "backend"] },
      { turn: 2, keywords: ["postgres", "schema"] },
      { turn: 3, keywords: ["postgres", "migration"] },
    ];
    const map = computeDecayedProfile(turns);
    // postgres: 0.65^2 + 0.65^1 + 0.65^0 = 0.4225 + 0.65 + 1 = 2.0725
    assert.ok(Math.abs(map.get("postgres") - 2.0725) < 1e-6, `expected 2.0725, got ${map.get("postgres")}`);
    // a persistently-mentioned term must outrank any single one-off term
    assert.ok(map.get("postgres") > map.get("backend"));
    assert.ok(map.get("postgres") > map.get("migration"));
  });

  it("computeDecayedProfile caps output at 64 terms (MAX_PROFILE_TERMS), keeping the highest-weight ones", () => {
    const keywords = Array.from({ length: 100 }, (_, i) => `term${i}`);
    const map = computeDecayedProfile([{ turn: 1, keywords }]);
    assert.ok(map.size <= 64, `expected <=64 terms, got ${map.size}`);
  });

  it("topicQuery merges current keywords (always included) with top decayed profile terms", () => {
    const priorProfile = computeDecayedProfile([
      { turn: 1, keywords: ["postgres", "billing", "migration"] },
    ]);
    const merged = topicQuery(["watch"], priorProfile);
    assert.ok(merged.includes("watch"), "current keyword must always be present");
    assert.ok(merged.includes("postgres") && merged.includes("billing") && merged.includes("migration"),
      `expected profile terms merged in, got ${JSON.stringify(merged)}`);
  });

  it("profileOnlyTerms excludes anything already present in current-prompt keywords", () => {
    const priorProfile = computeDecayedProfile([{ turn: 1, keywords: ["postgres", "billing"] }]);
    const terms = profileOnlyTerms(["postgres"], priorProfile);
    assert.ok(!terms.includes("postgres"), "must not duplicate a term already in current keywords");
    assert.ok(terms.includes("billing"));
  });
});

// ── 3. Background-then-generic-question scenario, end-to-end ──────────────

describe("topic-state: background-then-generic-question fires a recall the bare prompt wouldn't", () => {
  it("4 background turns build a profile; the 5th, generic prompt injects the seeded memory", async () => {
    const root = freshRoot("e2e-fire");
    const project = "e2e-fire";
    const sessionId = "e2e-fire-session";

    // Seed a memory whose own overlap with the final generic prompt is weak
    // ("watch" is the only shared word) but whose content strongly overlaps
    // the accumulated background-topic profile (billing/postgres/schema/migration).
    const seed = await runHook(root, ["--project", project, "write",
      "Billing migration Postgres schema conversion riskiest part watch foreign key drift orphaned rows cutover"], "");
    assert.equal(seed.code, 0, `seed write failed: ${seed.stderr}`);

    const backgroundTurns = [
      "we are migrating the billing service to a new backend this quarter and it is a big undertaking for the team",
      "the postgres schema for billing is the tricky part of this migration since it has years of legacy columns",
      "billing migration status update we finished half of the postgres schema conversion work today",
      "still working through the postgres schema changes for the billing migration before we can cut over",
    ];
    for (const turn of backgroundTurns) {
      const r = await runHook(root, ["--project", project, "hook-ambient"], buildStdin(turn, sessionId));
      assert.equal(r.code, 0, `background turn must exit 0, stderr=${r.stderr}`);
    }

    // Sanity: the profile file must now contain billing/postgres/migration/schema terms.
    const profile = loadProfile(root, sessionId);
    assert.ok(profile, "profile must exist after 4 background turns");
    const allProfileKeywords = new Set(profile.turns.flatMap((t) => t.keywords));
    for (const term of ["billing", "postgres", "migration", "schema"]) {
      assert.ok(allProfileKeywords.has(term), `expected "${term}" accumulated in profile, got ${JSON.stringify([...allProfileKeywords])}`);
    }

    // The 5th call (counter=5, counter%5===0) is guaranteed to pass the rate
    // limiter regardless of content, isolating the assertion to precision
    // logic rather than rate-limit luck.
    const final = await runHook(root, ["--project", project, "hook-ambient"], buildStdin("what should I watch out for?", sessionId));
    assert.equal(final.code, 0, `final turn must exit 0, stderr=${final.stderr}`);
    assert.ok(
      final.stdout.includes("[AgentRecall] Relevant past context:"),
      `expected background-informed injection, got: ${JSON.stringify(final.stdout)}`
    );
    assert.ok(
      /billing|postgres|schema|migration/i.test(final.stdout),
      `injected content should reference the background topic, got: ${final.stdout}`
    );
  });

  it("CONTRAST: the same generic prompt with NO prior background turns injects nothing", async () => {
    const root = freshRoot("e2e-contrast");
    const project = "e2e-contrast";

    await runHook(root, ["--project", project, "write",
      "Billing migration Postgres schema conversion riskiest part watch foreign key drift orphaned rows cutover"], "");

    // Fresh session, first call (counter=1, always fires) — but there is no
    // topic profile to draw on, and the prompt's own keywords ("watch") don't
    // clear the existing >=2-overlap current-prompt floor.
    const bare = await runHook(root, ["--project", project, "hook-ambient"], buildStdin("what should I watch out for?", "bare-session"));
    assert.equal(bare.code, 0, `stderr=${bare.stderr}`);
    assert.equal(bare.stdout.trim(), "", `bare prompt (no background profile) must not inject, got: ${bare.stdout}`);
  });
});

// ── 4. Precision guard: unrelated new topic doesn't drag old-profile injections ─

describe("topic-state: precision guard — unrelated topic profile does not spray old memories", () => {
  it("a profile built around an unrelated topic does not inject an unrelated stored memory", async () => {
    const root = freshRoot("precision-guard");
    const project = "precision-guard";
    const sessionId = "precision-guard-session";

    // Seed a memory about billing/postgres — completely unrelated to the
    // topic profile built below.
    const seed = await runHook(root, ["--project", project, "write",
      "Billing migration Postgres schema conversion riskiest part watch foreign key drift orphaned rows cutover"], "");
    assert.equal(seed.code, 0, `seed write failed: ${seed.stderr}`);

    // Build a profile around a DIFFERENT topic (dashboard/frontend/design) —
    // shares no content words with the seeded billing/postgres memory.
    const backgroundTurns = [
      "we are redesigning the marketing dashboard frontend with a new color palette this week",
      "the dashboard frontend redesign needs a review of typography and spacing before launch",
      "still polishing the dashboard frontend colors and fonts for the summer campaign launch",
      "dashboard frontend design status update the color palette is nearly finalized for launch",
    ];
    for (const turn of backgroundTurns) {
      const r = await runHook(root, ["--project", project, "hook-ambient"], buildStdin(turn, sessionId));
      assert.equal(r.code, 0, `background turn must exit 0, stderr=${r.stderr}`);
    }

    // Same generic follow-up as the fire-test above — but this session's
    // profile has ZERO overlap with the seeded billing/postgres memory, so
    // neither the current-prompt floor NOR the profile-assisted tier should
    // fire for it.
    const final = await runHook(root, ["--project", project, "hook-ambient"], buildStdin("what should I watch out for?", sessionId));
    assert.equal(final.code, 0, `stderr=${final.stderr}`);
    assert.equal(
      final.stdout.trim(),
      "",
      `unrelated topic profile must not drag in the billing/postgres memory, got: ${final.stdout}`
    );
  });
});

// ── 5. Staleness sweep ──────────────────────────────────────────────────────

describe("topic-state: session hygiene — staleness", () => {
  it("loadProfile discards AND deletes a profile file older than 24h on first touch", () => {
    const root = freshRoot("stale-24h");
    appendTurn(root, "sess-stale", ["foo", "bar"]);
    const file = topicStateFile(root, "sess-stale");
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    data.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    fs.writeFileSync(file, JSON.stringify(data), "utf-8");

    const loaded = loadProfile(root, "sess-stale");
    assert.equal(loaded, null, "a >24h-old profile must be treated as absent");
    assert.equal(fs.existsSync(file), false, "the stale file must be deleted, not just ignored");
  });

  it("a fresh (<24h) profile is NOT discarded", () => {
    const root = freshRoot("fresh-profile");
    appendTurn(root, "sess-fresh", ["foo"]);
    const loaded = loadProfile(root, "sess-fresh");
    assert.ok(loaded, "a freshly-written profile must load successfully");
    assert.equal(loaded.turns.length, 1);
  });

  it("sweepStaleProfiles removes sibling files untouched for 7+ days, keeps fresh ones", () => {
    const root = freshRoot("sweep");
    appendTurn(root, "sess-old", ["baz"]);
    const oldFile = topicStateFile(root, "sess-old");
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

    appendTurn(root, "sess-new", ["qux"]);
    const newFile = topicStateFile(root, "sess-new");

    const removed = sweepStaleProfiles(root);
    assert.equal(removed, 1, "exactly one 8-day-old sibling should be swept");
    assert.equal(fs.existsSync(oldFile), false, "8-day-old file must be removed");
    assert.equal(fs.existsSync(newFile), true, "fresh sibling file must survive the sweep");
  });

  it("hook-ambient end-to-end: a session whose profile file is >24h old starts a fresh profile instead of reusing stale background terms", async () => {
    const root = freshRoot("stale-e2e");
    const project = "stale-e2e";
    const sessionId = "stale-e2e-session";

    // Simulate a stale leftover profile from a day-old, unrelated conversation.
    appendTurn(root, sessionId, ["ancient", "unrelated", "topic", "words"]);
    const file = topicStateFile(root, sessionId);
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    data.updatedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
    fs.writeFileSync(file, JSON.stringify(data), "utf-8");

    // First touch after staleness — hook-ambient must not crash, and must
    // start accumulating fresh turns rather than reusing "ancient"/"unrelated".
    const r = await runHook(root, ["--project", project, "hook-ambient"], buildStdin("today we are debugging the payment retry logic in the queue worker", sessionId));
    assert.equal(r.code, 0, `stderr=${r.stderr}`);

    const reloaded = loadProfile(root, sessionId);
    assert.ok(reloaded, "a fresh profile must exist after the stale one was discarded");
    const kws = reloaded.turns.flatMap((t) => t.keywords);
    assert.ok(!kws.includes("ancient"), "stale terms must not survive into the fresh profile");
    assert.ok(kws.some((k) => ["debugging", "payment", "retry", "queue", "worker"].includes(k)),
      `expected fresh turn's keywords, got ${JSON.stringify(kws)}`);
  });
});

// ── 6. CJK background text building profile terms ──────────────────────────

describe("topic-state: CJK background text builds profile terms", () => {
  it("extractTopicKeywords extracts Han-script tokens from a Chinese prompt (unlike the English-only extractKeywords)", () => {
    const zh = "我们正在把账单服务迁移到新的后端，Postgres数据库的schema迁移是最麻烦的部分";
    const kws = extractTopicKeywords(zh);
    assert.ok(kws.length > 0, "must extract at least one token from CJK text");
    assert.ok(kws.includes("迁移"), `expected "迁移" (migration) among tokens, got ${JSON.stringify(kws)}`);
    assert.ok(kws.includes("账单"), `expected "账单" (billing) among tokens, got ${JSON.stringify(kws)}`);
  });

  it("a Chinese-only background conversation accumulates a profile whose decayed map contains the CJK terms", () => {
    const root = freshRoot("cjk-profile");
    const turn1 = extractTopicKeywords("我们正在把账单服务迁移到新的后端");
    const turn2 = extractTopicKeywords("数据库迁移进度更新，schema还在处理中");
    appendTurn(root, "sess-cjk", turn1);
    appendTurn(root, "sess-cjk", turn2);

    const loaded = loadProfile(root, "sess-cjk");
    const decayed = computeDecayedProfile(loaded.turns);
    assert.ok(decayed.has("迁移"), `expected "迁移" in decayed profile, got ${JSON.stringify([...decayed.keys()])}`);
    // "迁移" appears in both turns — must accumulate more weight than a term
    // appearing in only the oldest turn.
    const onlyInOldest = turn1.find((k) => !turn2.includes(k) && k !== "迁移");
    if (onlyInOldest) {
      assert.ok(decayed.get("迁移") > decayed.get(onlyInOldest),
        `a recurring CJK term must outrank a one-off CJK term from the same window`);
    }
  });

  it("hook-ambient end-to-end: CJK background turns build a profile that informs a later generic (English) question", async () => {
    const root = freshRoot("cjk-e2e");
    const project = "cjk-e2e";
    const sessionId = "cjk-e2e-session";

    const seed = await runHook(root, ["--project", project, "write",
      "账单迁移 Postgres schema 转换是最麻烦的部分 需要注意外键漂移和孤立行 cutover watch"], "");
    assert.equal(seed.code, 0, `seed write failed: ${seed.stderr}`);

    const backgroundTurns = [
      "我们正在把账单服务迁移到新的后端，这个季度工作量很大",
      "账单的Postgres schema是这次迁移最麻烦的部分，历史遗留字段很多",
      "账单迁移进度更新，今天完成了一半的schema转换工作",
      "还在处理账单迁移的schema变更，之后才能完成cutover",
    ];
    for (const turn of backgroundTurns) {
      const r = await runHook(root, ["--project", project, "hook-ambient"], buildStdin(turn, sessionId));
      assert.equal(r.code, 0, `background turn must exit 0, stderr=${r.stderr}`);
    }

    const profile = loadProfile(root, sessionId);
    assert.ok(profile, "profile must exist after CJK background turns");
    const allKeywords = new Set(profile.turns.flatMap((t) => t.keywords));
    assert.ok(allKeywords.has("账单") || allKeywords.has("迁移"),
      `expected CJK billing/migration terms accumulated, got ${JSON.stringify([...allKeywords])}`);

    // English-only extractKeywords on a bare CJK prompt returns an empty set
    // (it strips all non-ASCII input) — without this module's CJK-aware
    // extraction, none of the above would ever have reached the profile.
    const final = await runHook(root, ["--project", project, "hook-ambient"], buildStdin("what should I watch out for?", sessionId));
    assert.equal(final.code, 0, `stderr=${final.stderr}`);
    assert.ok(
      final.stdout.includes("[AgentRecall] Relevant past context:"),
      `expected CJK-background-informed injection, got: ${JSON.stringify(final.stdout)}`
    );
  });
});
