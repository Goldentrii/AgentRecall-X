#!/usr/bin/env node
/**
 * scale.mjs — 2026-10-15 adversarial scale test: does keyword recall hold
 * hit@5 and latency as the journal grows to 1k / 10k entries?
 *
 * Deterministic synthetic corpus (mulberry32 seed 42): N journal entries of
 * generic dev chatter sharing vocabulary with the needles, 10 planted
 * needle facts, 10 needle queries with normal lexical overlap. Measures
 * hit@5 + per-query latency (3 warmups, 3 timed repeats x 10 queries).
 *
 * Usage: node scripts/eval/adversarial-2026-10-15/scale.mjs [--n 1000,10000]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { scrubEnv, makeStore, writeJournal, writePalace, rng, pct } from "./store-lib.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const CORE_DIST = path.join(REPO, "packages", "core", "dist", "index.js");

scrubEnv();
delete process.env.AGENT_RECALL_EMBEDDINGS;
const core = await import(url.pathToFileURL(CORE_DIST).href);

const sizesArg = process.argv.indexOf("--n");
const SIZES = sizesArg >= 0 ? process.argv[sizesArg + 1].split(",").map(Number) : [1000, 10000];
const P = "scale-project";

const NEEDLES = [
  { fact: "The staging S3 bucket is named velvet-otter-staging-347.", q: "what is the staging S3 bucket name", re: /velvet-otter-staging-347/ },
  { fact: "Postgres failover runbook lives at runbooks/pg-failover-v3.md, owned by Priya.", q: "where is the postgres failover runbook", re: /pg-failover-v3/ },
  { fact: "The webhook signing secret rotates every 90 days via the keymaster cron.", q: "how often does the webhook signing secret rotate", re: /90 days|keymaster/ },
  { fact: "Checkout feature flag checkout_v2_rollout is capped at 25 percent until fraud review.", q: "what percentage is the checkout_v2_rollout flag at", re: /25 percent|checkout_v2_rollout/ },
  { fact: "Grafana admin access requires the infra-admins LDAP group plus hardware key.", q: "who can get grafana admin access", re: /infra-admins|hardware key/ },
  { fact: "The invoice PDF renderer was moved to the billing-render pod with 2GB memory limit.", q: "which pod renders invoice PDFs", re: /billing-render/ },
  { fact: "Mobile API v1 sunset date is 2027-03-31, announced in the March newsletter.", q: "when does mobile API v1 sunset", re: /2027-03-31/ },
  { fact: "Search reindex takes 42 minutes on the production cluster, run it off-peak.", q: "how long does the search reindex take", re: /42 minutes/ },
  { fact: "The on-call escalation pager number routes through Opsgenie team platform-core.", q: "which opsgenie team gets escalations", re: /platform-core/ },
  { fact: "Terraform state is locked via DynamoDB table tf-locks-prod-eu.", q: "which dynamodb table locks terraform state", re: /tf-locks-prod-eu/ },
];

const VOCAB = ("deploy rollout cache redis cluster service api endpoint latency p95 dashboard grafana alert pager oncall " +
  "review merge branch pipeline build test flake retry queue kafka topic consumer lag postgres index migration schema " +
  "bucket s3 storage billing invoice customer ticket escalation flag feature percent staging production secret rotate " +
  "runbook incident postmortem memory limit pod kubernetes terraform state lock newsletter sunset search reindex").split(" ");

function sentence(r, n) {
  const words = [];
  for (let i = 0; i < n; i++) words.push(VOCAB[Math.floor(r() * VOCAB.length)]);
  return words.join(" ");
}

const results = [];
for (const N of SIZES) {
  const r = rng(42);
  const root = makeStore(`scale-${N}`);
  process.env.AGENT_RECALL_ROOT = root;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const y = 2026, m = (i % 9) + 1, d = (i % 27) + 1;
    const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    writeJournal(root, P, date, `entry-${i}`,
      `# ${date} entry ${i}\n\n## Work\n\nDiscussed ${sentence(r, 10)}.\nFollow-up: ${sentence(r, 8)}.\n\n## Decisions\n\nNo decision; revisit ${sentence(r, 5)}.\n`);
  }
  // Plant needles at deterministic spread positions (as palace decisions + journals, half/half).
  NEEDLES.forEach((nd, i) => {
    if (i % 2 === 0) {
      writePalace(root, P, "decisions", `needle-${i}`, `# Needle ${i}\n\n## Decision (2026-09-0${(i % 9) + 1})\n\n${nd.fact}\n`);
    } else {
      writeJournal(root, P, `2026-09-1${i % 9}`, `needle-${i}`, `# needle ${i}\n\n## Decisions\n\n${nd.fact}\n`);
    }
  });
  const genMs = Date.now() - t0;

  // Warmups
  for (let w = 0; w < 3; w++) await core.smartRecall({ query: NEEDLES[w].q, project: P, limit: 10 });

  const lat = [];
  let hits = 0;
  const misses = [];
  for (let rep = 0; rep < 3; rep++) {
    for (const nd of NEEDLES) {
      const s = process.hrtime.bigint();
      const res = await core.smartRecall({ query: nd.q, project: P, limit: 10 });
      lat.push(Number(process.hrtime.bigint() - s) / 1e6);
      if (rep === 0) {
        const hit = res.results.slice(0, 5).some((x) => nd.re.test(x.title + " " + x.excerpt));
        if (hit) hits++; else misses.push(nd.q);
      }
    }
  }
  lat.sort((a, b) => a - b);
  const row = {
    n: N, genMs,
    hitAt5: `${hits}/${NEEDLES.length}`,
    p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1), max: +lat[lat.length - 1].toFixed(1),
    misses,
  };
  results.push(row);
  console.log(`N=${N}  gen=${genMs}ms  hit@5=${row.hitAt5}  recall p50=${row.p50}ms p95=${row.p95}ms max=${row.max}ms${misses.length ? "  misses: " + misses.join(" | ") : ""}`);
}
fs.writeFileSync(path.join(HERE, "results-scale.json"), JSON.stringify(results, null, 2));
console.log(`results: ${path.join(HERE, "results-scale.json")}`);
