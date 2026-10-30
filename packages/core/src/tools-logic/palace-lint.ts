import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { resolveProject } from "../storage/project.js";
import { palaceDir } from "../storage/paths.js";
import { ensurePalaceInitialized, listRooms } from "../palace/rooms.js";
import { getConnectionCount } from "../palace/graph.js";
import { computeSalience, ARCHIVE_THRESHOLD } from "../palace/salience.js";
import { updatePalaceIndex } from "../palace/index-manager.js";
import { appendToLog } from "../palace/log.js";
import { appendLedgerEvent } from "../ledger/append.js";
import { flushLedgerQueue } from "../storage/ledger-queue.js";

export interface LintIssue {
  type: "stale" | "orphan" | "low_salience" | "empty" | "missing_readme";
  severity: "warning" | "info";
  room: string;
  description: string;
  suggestion: string;
}

export interface PalaceLintInput {
  fix?: boolean;
  project?: string;
}

export interface PalaceLintResult {
  project: string;
  issues: LintIssue[];
  total_issues: number;
  fixed: number;
  rooms_checked: number;
}

export async function palaceLint(input: PalaceLintInput): Promise<PalaceLintResult> {
  const slug = await resolveProject(input.project);
  const fix = input.fix ?? false;
  ensurePalaceInitialized(slug);

  const rooms = listRooms(slug);
  const pd = palaceDir(slug);
  const issues: LintIssue[] = [];
  let fixed = 0;

  for (const room of rooms) {
    const roomPath = path.join(pd, "rooms", room.slug);

    const connCount = getConnectionCount(pd, room.slug);
    if (connCount === 0 && room.connections.length === 0) {
      issues.push({
        type: "orphan", severity: "warning", room: room.slug,
        description: `Room '${room.name}' has no connections to other rooms`,
        suggestion: "Add connections via: ar palace write <room> '<content with [[wikilinks]]>'",
      });
    }

    const daysSinceAccess = (Date.now() - new Date(room.last_accessed).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceAccess > 30) {
      issues.push({
        type: "stale", severity: "info", room: room.slug,
        description: `Room '${room.name}' not accessed in ${Math.floor(daysSinceAccess)} days`,
        suggestion: "Review if still relevant. Access it to refresh salience.",
      });
    }

    const salience = computeSalience({ importance: "medium", lastUpdated: room.updated, accessCount: room.access_count, connectionCount: connCount });
    if (salience < ARCHIVE_THRESHOLD) {
      issues.push({
        type: "low_salience", severity: "warning", room: room.slug,
        description: `Room '${room.name}' salience is ${salience.toFixed(3)} (below ${ARCHIVE_THRESHOLD})`,
        suggestion: fix ? "Auto-archiving..." : "Consider archiving or refreshing with new content",
      });

      if (fix && fs.existsSync(roomPath)) {
        const archiveDir = path.join(pd, "archive", room.slug);
        fs.mkdirSync(archiveDir, { recursive: true });
        const files = fs.readdirSync(roomPath);
        // Hash the .md files BEFORE the room dir is removed (ledger: *.delete-style).
        const hashed = files.filter((f) => f.endsWith(".md")).map((f) => {
          const raw = fs.readFileSync(path.join(roomPath, f));
          return { file: f, raw, sha256: createHash("sha256").update(raw).digest("hex") };
        });
        for (const file of files) {
          fs.copyFileSync(path.join(roomPath, file), path.join(archiveDir, file));
        }
        fs.rmSync(roomPath, { recursive: true });
        fixed++;
        // Provenance (ledger): each .md left rooms/<room>/ and arrived in archive/<room>/.
        for (const h of hashed) {
          await appendLedgerEvent({
            type: "palace.consolidate", project: slug, target: path.join(roomPath, h.file),
            sha256: h.sha256, bytes: h.raw.length,
            meta: { room: room.slug, kind: "room-archive", moved_to: `archive/${room.slug}/${h.file}` },
          });
          await appendLedgerEvent({
            type: "palace.consolidate", project: slug, target: path.join(archiveDir, h.file),
            sha256: h.sha256, bytes: h.raw.length,
            meta: { room: room.slug, kind: "room-archive", moved_from: `rooms/${room.slug}/${h.file}` },
          });
        }
      }
    }

    if (fs.existsSync(roomPath)) {
      const files = fs.readdirSync(roomPath).filter((f) => f.endsWith(".md") && f !== "README.md");
      if (files.length === 0) {
        issues.push({
          type: "empty", severity: "info", room: room.slug,
          description: `Room '${room.name}' has no topic files (only README)`,
          suggestion: `Add content via: ar palace write ${room.slug} '<content>' [--importance high|medium|low]`,
        });
      }
    }

    if (!fs.existsSync(path.join(roomPath, "README.md"))) {
      issues.push({
        type: "missing_readme", severity: "warning", room: room.slug,
        description: `Room '${room.name}' is missing README.md`,
        suggestion: "Recreate with: ar palace write <room> '<content>'",
      });
    }
  }

  if (fix && fixed > 0) {
    await updatePalaceIndex(slug);
  }

  const indexPath = path.join(pd, "palace-index.json");
  if (fs.existsSync(indexPath)) {
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      index.last_lint = new Date().toISOString();
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
    } catch { /* ignore */ }
  }

  await flushLedgerQueue(); // room/identity scaffold events queued by sync helpers
  appendToLog(slug, "palace_lint", { issues_found: issues.length, fixed, rooms_checked: rooms.length });

  return { project: slug, issues, total_issues: issues.length, fixed, rooms_checked: rooms.length };
}
