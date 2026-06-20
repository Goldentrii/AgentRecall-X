/**
 * memory-protocol.ts — the SINGLE self-describing protocol generator (Wave 2,
 * Decision #5). Writes a `MEMORY-PROTOCOL.md` into a project's folder so a cold
 * agent (Cursor / Codex / OpenCode, no MCP) can read and write the memory tree
 * by convention alone — substrate-independent, local-first.
 *
 * Non-goal lock (see plan §6): there is NO live/synchronous sidecar storage
 * agent. Retrieval is a function (smartRecall / check); consolidation is the
 * async dreaming agent. Do NOT reintroduce a spawned per-recall agent.
 *
 * This is the ONLY protocol-doc generator. Do not also build `protocol-doc.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { sanitizeProject } from "./paths.js";
import { ensureDir } from "./fs-utils.js";

const PROTOCOL_FILENAME = "MEMORY-PROTOCOL.md";

function projectRoot(project: string): string {
  const safe = sanitizeProject(project);
  const root = getRoot();
  const resolved = path.join(root, "projects", safe);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(rootWithSep)) {
    throw new Error(`Invalid project name (path escape): ${project}`);
  }
  return resolved;
}

const PROTOCOL_BODY = `# AgentRecall — Memory Protocol

> Self-describing, substrate-independent memory layout. A cold agent (no MCP)
> can read and write this folder by convention alone. Local-first; an optional
> local git commit substrate may sit on top, but **no remote push** is wired
> until the privacy split is proven.

## Two-tier memory with a bridge

\`\`\`
journal/archive/raw/      ← MECHANICAL ARCHIVE (lossless, verbatim, never lost)
                            appended on EVERY session end, zero judgment.
awareness / palace skills ← QUALITY COMPRESSION (lossy, reasoned)
                            distilled by the async dreaming loop, NOT in the Stop turn.
\`\`\`

When the compressed tier is **not confident**, retrieval drills DOWN into the
lossless archive instead of answering thinly (the bridge).

## Folder layout

- \`journal/\` — curated session stream (capped excerpts; the working narrative).
- \`journal/archive/raw/<date>--<sessionId>.md\` — verbatim session dumps. Each
  file has small frontmatter (\`project, sessionId, savedAt, source\`) then the
  raw transcript head+tail. **Never** synced to any remote.
- \`journal/archive/raw/.consumed.json\` — \`{ lastConsumedOffset, lastConsumedAt }\`.
  The dreaming loop advances this marker as it distills raw segments upward.
- \`journal/archive/index.md\` — one append-only line per dump.
- \`palace/\` — rooms (project knowledge), skills (procedural memory), pipeline,
  awareness (behavioral layer — PERSONAL, sync-excluded by default).
- \`corrections/\` — human corrections (PERSONAL, never synced).

## Consume seam (async dreaming)

Raw dumps are queued for compression, never compressed inside the Stop turn:

\`\`\`
~/.agent-recall/.consolidation-queue/<date>.jsonl   ← one JSON job per line
\`\`\`

A job looks like \`{ "project", "sessionId", "reason", "at", "done"? }\`.
Drain the queue out-of-band (e.g. \`ar consolidate-async\`): run consolidation
per job, mark each line \`done:true\`. One bad job must never block the rest.

## Cold-agent read/write rules

1. To **read**: prefer the curated \`journal/\` + \`palace/\`. If a hit is
   low-confidence, open the matching \`journal/archive/raw/\` file verbatim.
2. To **write a session**: append a verbatim file under \`journal/archive/raw/\`
   keyed on the session UUID (idempotent), then enqueue a consolidation job.
3. **Never** sync \`awareness\`, \`corrections\`, \`personal/\`, or \`_global\` palace
   to any remote without an explicit \`sync_personal=true\` opt-in.
`;

/**
 * Write the project's MEMORY-PROTOCOL.md if it is absent (write-once).
 * Best-effort: never throws — returns the path (written or pre-existing) or
 * an empty string on failure.
 */
export function writeMemoryProtocol(project: string): string {
  try {
    const dir = projectRoot(project);
    const dest = path.join(dir, PROTOCOL_FILENAME);
    if (fs.existsSync(dest)) return dest; // write-once
    ensureDir(dir);
    fs.writeFileSync(dest, PROTOCOL_BODY, "utf-8");
    return dest;
  } catch {
    return "";
  }
}
