"""Write per-case acceptance results for run 2026-09-27-r1 (orchestrator-authored status sheet).

Statuses follow PLAN §0.2/§12: PASS only with evidence + independent verifier; phase-level
subset evidence is attached to NOT_RUN/BLOCKED cases but never upgrades them.
Usage: python write-run-results.py <final_commit> <evaluator_commit>
"""
import json
import sys
from pathlib import Path

FINAL, EVAL = sys.argv[1], sys.argv[2]
RUN = Path("reports/shared-memory-evolution/2026-09-27-r1")
OUT = RUN / "results"
OUT.mkdir(parents=True, exist_ok=True)
ENV = "reports/shared-memory-evolution/2026-09-27-r1/manifest.json (Windows 11, Node 24.11.1)"
T = "2026-09-27"

NO_CLOUD = "BLOCKED: no real isolated Supabase project/credentials; PGlite (PG 18.3 WASM) subset is not a substitute (PLAN §8 P2)."
NO_HOSTS = "BLOCKED: no second device/VM and no real multi-host setup available on this machine."
NO_BUDGET = "BLOCKED: paid A/B/C evaluation (~$2.2k est., adr/budget-estimate.md) not approved; no independent held-out task set exists."
P3 = "NOT_RUN: P3 (five-tool/SDK/CLI integration + migration) not started in this run."
P4 = "NOT_RUN: P4 (scope/derived/conflict/handoff/guardedAction integration) not started."
P5 = "NOT_RUN: P5 (outcome ledger/experience worker) not started; ADR-002 frozen only."
P6 = "NOT_RUN: P6 (fault/perf/security/cross-platform) not started."
P7 = "NOT_RUN: P7 (real hosts, docs, final sign-off) not started."

subset_local = f"{RUN}/tests/final-integration/suite-local.tap"
subset_pg = f"{RUN}/tests/final-integration/suite-pglite.tap"

cases = {
    "A01": ("BLOCKED", "No Ubuntu host/WSL/Docker; Windows baseline: 36 pre-existing failures preserved as baseline exceptions, 0 new failure names at final commit; remote CI red at baseline (heeded-guard 5/9).",
            [f"{RUN}/baseline/results.json", f"{RUN}/tests/final-integration/summary.txt"]),
    "A02": ("PASS", "ADR-001 rev1->rev2->rev2.1->rev2.2 + contract.ts frozen; R0 (18 blockers) and R0b (4 defects) closed; rev2.2 __proto__ fix confirmed by independent suite reviewer.",
            [f"{RUN}/adr/contracts.md", f"{RUN}/adr/contracts-rev2.md", f"{RUN}/reviews/contracts-review.md", f"{RUN}/reviews/contracts-rereview.md", f"{RUN}/reviews/suite-review.md"]),
    "A03": ("NOT_RUN", P3 + " Subset: LocalRepository external_edit/Markdown view unit tests pass.", [subset_local]),
    "A04": ("NOT_RUN", P3 + " Subset: SDK Case B hard test + 60-call two-root isolation test pass; cloud principals half needs real Supabase.", [f"{RUN}/tests/final-integration/sdk.log"]),
    "A05": ("BLOCKED", NO_CLOUD, []),
    "A06": ("NOT_RUN", P4, [subset_local, subset_pg]),
    "A07": ("BLOCKED", NO_CLOUD + " Subset: G-visibility >=1000-request matrix on PGlite harness.", [subset_pg]),
    "A08": ("BLOCKED", NO_CLOUD + " Local half: G-durability 1000 writes/fault kind on local harness.", [subset_local]),
    "A09": ("NOT_RUN", P5 + " Subset: G-idem on both harnesses.", [subset_local, subset_pg]),
    "A10": ("BLOCKED", NO_CLOUD + " Local half + PGlite: G-cas 100 pairs.", [subset_local, subset_pg]),
    "A11": ("BLOCKED", NO_CLOUD + " PGlite offline subset: G-outbox.", [subset_pg]),
    "A12": ("BLOCKED", NO_CLOUD + " PGlite ack_lost subset: G-ackloss.", [subset_pg]),
    "A13": ("BLOCKED", NO_CLOUD + " Subset: G-cursor 1000 events.", [subset_local, subset_pg]),
    "A14": ("NOT_RUN", P3, []),
    "A15": ("NOT_RUN", P3 + " Also requires real Supabase.", []),
    "A16": ("NOT_RUN", P4, []),
    "A17": ("NOT_RUN", P4, []),
    "A18": ("NOT_RUN", P4 + " Also requires real Supabase.", []),
    "A19": ("NOT_RUN", P3, []),
    "A20": ("NOT_RUN", P4, []),
    "A21": ("NOT_RUN", P4 + " Subset: G-handoff.", [subset_local, subset_pg]),
    "A22": ("NOT_RUN", P5 + " egress-guard.mjs exists (4 documented residual gaps).", ["scripts/acceptance/egress-guard.mjs"]),
    "A23": ("NOT_RUN", P6 + " Subset: path-traversal tests pass (Windows only).", [subset_local]),
    "A24": ("NOT_RUN", P6, []),
    "A25": ("NOT_RUN", P6 + " Subset: cloud scrub tests for create/update/supersede incl. outbox file.", []),
    "A26": ("BLOCKED", NO_CLOUD + " PGlite subset: REVOKE/RLS direct-DML denial tests.", [subset_pg]),
    "A27": ("BLOCKED", NO_CLOUD, []),
    "A28": ("NOT_RUN", P5, []),
    "A29": ("NOT_RUN", P5 + " Local-shell forgery is a documented residual risk (ADR R2.8) and can never be PASS.", []),
    "A30": ("BLOCKED", NO_HOSTS + " " + NO_CLOUD, []),
    "A31": ("BLOCKED", "Cloud reference environment not frozen (no Supabase region/plan); local perf not run (P6).", []),
    "A32": ("NOT_RUN", P3, []),
    "A33": ("NOT_RUN", P3, []),
    "A34": ("NOT_RUN", P5, [f"{RUN}/adr/ADR-002-experience-evolution.md"]),
    "A35": ("NOT_RUN", P5, []),
    "A36": ("NOT_RUN", P5, []),
    "A37": ("NOT_RUN", P5, []),
    "A38": ("BLOCKED", NO_HOSTS + " Requires 2 real hosts x 40 sessions.", []),
    "A39": ("NOT_RUN", P7 + " Evolution evaluator/held-out not built; contract-suite frozen evaluator exists.", ["scripts/acceptance/contract-suite.mjs"]),
    "A40": ("NOT_RUN", P7 + " Partial evidence: Plywood v0.5.1 compile/validate/feedback used; dispatch via Claude Code Agent tool; briefs + receipts saved.", [f"{RUN}/orchestration/workers.json", f"{RUN}/orchestration/feedback-receipts.log"]),
    "A41": ("NOT_RUN", P6, []),
    "A42": ("BLOCKED", NO_BUDGET, [f"{RUN}/adr/budget-estimate.md"]),
    "A43": ("BLOCKED", NO_BUDGET, []),
    "A44": ("BLOCKED", NO_BUDGET, []),
    "A45": ("BLOCKED", NO_BUDGET, []),
    "A46": ("NOT_RUN", P7 + " README/package docs not updated for new capability; user README edits preserved.", []),
    "A47": ("NOT_RUN", P7, []),
}

results = []
for cid, (status, reason, evidence) in cases.items():
    r = {
        "id": cid,
        "status": status,
        "commit": FINAL,
        "evaluator_commit": EVAL,
        "environment": ENV,
        "command": "independent review chain (see evidence)" if status == "PASS" else "not executed as a full case; see reason",
        "started_at": T,
        "exit_code": 0 if status == "PASS" else None,
        "metrics": {},
        "evidence": [e for e in evidence if Path(e).exists()],
        "verified_by": "R0b contract re-reviewer + WP-V step-0 + suite reviewer" if status == "PASS" else "n/a",
        "reason": reason,
    }
    results.append(r)
    (OUT / f"{cid}.json").write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")

(RUN / "acceptance-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
counts = {}
for r in results:
    counts[r["status"]] = counts.get(r["status"], 0) + 1
print(len(results), counts)
