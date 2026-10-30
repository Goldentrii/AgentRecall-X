/**
 * verifyLedger — read-only audit of the ledger against the files on disk.
 * Writes NOTHING (no heads rebuild, no ledger/ dir): a broken chain or a
 * stale heads.json is a finding, never a repair.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getRoot } from "../types.js";
import { computeHeads, readHeads } from "./heads.js";
import { readEventsWithStats } from "./read.js";
import type { LedgerActor, LedgerEvent, LedgerVia } from "./types.js";
import { walkLedgeredFiles } from "./walk.js";

export type LedgerFindingKind = "orphan" | "drift" | "missing" | "chain" | "unknown-via";

export interface LedgerFinding {
  kind: LedgerFindingKind;
  project: string;
  target: string | null;
  detail: string;
  eventId?: string;
}

export interface LedgerVerifyResult {
  findings: LedgerFinding[];
  scanned: { files: number; events: number; projects: number; badLines: number };
}

const KNOWN_VIA: readonly LedgerVia[] = ["mcp", "cli", "hook", "file-fallback", "backfill", "library"];
const KNOWN_ACTOR: readonly LedgerActor[] = ["agent", "hook", "user", "system"];

function sha256File(abs: string): string {
  return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

/** A target that would resolve outside the store is a schema violation, never read. */
function escapesStore(target: string): boolean {
  return path.isAbsolute(target) || target.split(/[\\/]/).includes("..");
}

export function verifyLedger(project?: string, root: string = getRoot()): LedgerVerifyResult {
  const { events, badLines } = readEventsWithStats(project ? { project } : {}, root);
  const findings: LedgerFinding[] = [];

  if (badLines > 0) {
    findings.push({
      kind: "unknown-via",
      project: project ?? "_global",
      target: null,
      detail: `${badLines} unparsable line(s) in ledger/events.jsonl`,
    });
  }

  // chain: each event's parent is the previous event of the same project
  const byProject = new Map<string, LedgerEvent[]>();
  for (const ev of events) {
    const list = byProject.get(ev.project);
    if (list) list.push(ev);
    else byProject.set(ev.project, [ev]);
  }
  for (const [p, list] of byProject) {
    let expected: string | null = null;
    for (const ev of list) {
      if (ev.parent !== expected) {
        findings.push({
          kind: "chain",
          project: p,
          target: ev.target,
          detail: `parent ${ev.parent} != expected ${expected}`,
          eventId: ev.id,
        });
      }
      expected = ev.id;
    }
  }

  // heads.json is derived: compare it with what the events imply
  const stored = readHeads(root);
  const derived = computeHeads(root).heads;
  for (const p of new Set([...Object.keys(derived), ...Object.keys(stored)])) {
    if (project !== undefined && p !== project) continue;
    const want = derived[p];
    const have = stored[p];
    if (want && (have?.head !== want.head || have?.count !== want.count)) {
      findings.push({
        kind: "chain",
        project: p,
        target: null,
        detail: `heads.json ${have ? `${have.head} (count ${have.count})` : "has no entry"} != last event ${want.head} (count ${want.count})`,
        eventId: want.head,
      });
    } else if (!want && have) {
      findings.push({ kind: "chain", project: p, target: null, detail: "heads.json names a project with no events" });
    }
  }

  // schema: v / via / actor / target
  for (const ev of events) {
    const bad: string[] = [];
    if (ev.v !== 1) bad.push(`v ${String(ev.v)}`);
    if (!KNOWN_VIA.includes(ev.via)) bad.push(`via "${String(ev.via)}"`);
    if (!KNOWN_ACTOR.includes(ev.actor)) bad.push(`actor "${String(ev.actor)}"`);
    if (typeof ev.target === "string" && escapesStore(ev.target)) bad.push(`target outside store "${ev.target}"`);
    if (bad.length > 0) {
      findings.push({
        kind: "unknown-via",
        project: ev.project,
        target: ev.target ?? null,
        detail: `schema violation: ${bad.join(", ")}`,
        eventId: ev.id,
      });
    }
  }

  // latest event per target (file order) vs the file on disk
  const latest = new Map<string, LedgerEvent>();
  const deleted = new Set<string>();
  for (const ev of events) {
    if (typeof ev.target === "string" && !escapesStore(ev.target)) latest.set(ev.target, ev);
    if (ev.type === "project.delete") deleted.add(ev.project);
    else deleted.delete(ev.project);
  }
  for (const [target, ev] of latest) {
    if (deleted.has(ev.project)) continue;
    if (ev.sha256 === null) continue; // event carried no hash (derived file, or absent at write time)
    const abs = path.join(root, target);
    if (!fs.existsSync(abs)) {
      findings.push({
        kind: "missing",
        project: ev.project,
        target,
        detail: "ledger says file exists, file is gone",
        eventId: ev.id,
      });
      continue;
    }
    let actual: string | null = null;
    try {
      actual = sha256File(abs);
    } catch {
      // unreadable (directory, permissions): cannot match the recorded hash
    }
    if (actual !== ev.sha256) {
      findings.push({
        kind: "drift",
        project: ev.project,
        target,
        detail: actual === null ? "file unreadable, cannot match ledger hash" : "file hash != latest ledger hash",
        eventId: ev.id,
      });
    }
  }

  const files = walkLedgeredFiles(root, project);
  for (const f of files) {
    if (!latest.has(f.target)) {
      findings.push({ kind: "orphan", project: f.project, target: f.target, detail: "ledgered-class file has no ledger event" });
    }
  }

  const cmp = (a: string | null, b: string | null): number => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0);
  findings.sort((a, b) => cmp(a.project, b.project) || cmp(a.kind, b.kind) || cmp(a.target, b.target));

  const projects = new Set<string>([...byProject.keys(), ...files.map((f) => f.project)]);
  return { findings, scanned: { files: files.length, events: events.length, projects: projects.size, badLines } };
}
