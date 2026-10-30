import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { resolveProject } from "../storage/project.js";
import { journalDir } from "../storage/paths.js";
import { ensureDir } from "../storage/fs-utils.js";
import { listJournalFiles, updateIndex } from "../helpers/journal-files.js";
import { groupByWeek, synthesizeWeek } from "../helpers/rollup.js";
import { stateFilePath } from "./journal-state.js";
import { appendLedgerEvent } from "../ledger/append.js";
import { fileDigest } from "../storage/ledger-queue.js";

export interface JournalRollupInput {
  min_age_days?: number;
  min_entries?: number;
  dry_run?: boolean;
  project?: string;
}

export interface JournalRollupResult {
  project: string;
  dry_run: boolean;
  weeksRolledUp: number;
  entriesArchived: number;
  summariesCreated: string[];
  skipped: string[];
}

export async function journalRollup(input: JournalRollupInput): Promise<JournalRollupResult> {
  const slug = await resolveProject(input.project);
  const entries = listJournalFiles(slug);
  const dir = journalDir(slug);
  const archiveDir = path.join(dir, "archive");
  const minAgeDays = input.min_age_days ?? 7;
  const minEntries = input.min_entries ?? 2;
  const dryRun = input.dry_run ?? false;

  const result = {
    project: slug,
    dry_run: dryRun,
    weeksRolledUp: 0,
    entriesArchived: 0,
    summariesCreated: [] as string[],
    skipped: [] as string[],
  };

  const groups = groupByWeek(entries);

  for (const [wk, weekEntries] of groups) {
    const summaryFile = `${wk}.md`;
    if (fs.existsSync(path.join(dir, summaryFile))) {
      result.skipped.push(`${wk}: already exists`);
      continue;
    }

    if (weekEntries.length < minEntries) {
      result.skipped.push(`${wk}: only ${weekEntries.length} entries (need ${minEntries}+)`);
      continue;
    }

    const newestEntry = weekEntries[weekEntries.length - 1];
    const ageMs = Date.now() - new Date(newestEntry.date).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < minAgeDays) {
      result.skipped.push(`${wk}: newest entry ${newestEntry.date} is only ${ageDays.toFixed(0)}d old`);
      continue;
    }

    if (dryRun) {
      result.summariesCreated.push(`${wk} (${weekEntries.length} entries → would create ${summaryFile})`);
      result.entriesArchived += weekEntries.length;
      result.weeksRolledUp++;
      continue;
    }

    const summary = synthesizeWeek(wk, weekEntries);
    fs.writeFileSync(path.join(dir, summaryFile), summary, "utf-8");
    result.summariesCreated.push(summaryFile);
    // Provenance (ledger): the weekly summary is a new journal file.
    await appendLedgerEvent({
      type: "journal.rollup",
      project: slug,
      target: path.join(dir, summaryFile),
      sha256: createHash("sha256").update(Buffer.from(summary, "utf-8")).digest("hex"),
      bytes: Buffer.byteLength(summary, "utf-8"),
      meta: { file: summaryFile, entries: weekEntries.length },
    });

    ensureDir(archiveDir);
    for (const entry of weekEntries) {
      const srcPath = path.join(entry.dir, entry.file);
      const destPath = path.join(archiveDir, entry.file);
      if (fs.existsSync(srcPath)) {
        // Hash BEFORE the move: the event sits on the path that left journal/*.md.
        const entryDigest = fileDigest(srcPath);
        fs.copyFileSync(srcPath, destPath);
        fs.unlinkSync(srcPath);
        await appendLedgerEvent({
          type: "journal.rollup",
          project: slug,
          target: srcPath,
          sha256: entryDigest.sha256,
          bytes: entryDigest.bytes,
          meta: { file: entry.file, moved_to: `archive/${entry.file}`, rolled_into: summaryFile },
        });

        const stateSrc = stateFilePath(slug, entry.date);
        if (fs.existsSync(stateSrc)) {
          fs.copyFileSync(stateSrc, path.join(archiveDir, `${entry.date}.state.json`));
          fs.unlinkSync(stateSrc);
        }

        const logSrc = path.join(entry.dir, `${entry.date}-log.md`);
        if (fs.existsSync(logSrc)) {
          const logDigest = fileDigest(logSrc);
          fs.copyFileSync(logSrc, path.join(archiveDir, `${entry.date}-log.md`));
          fs.unlinkSync(logSrc);
          await appendLedgerEvent({
            type: "journal.rollup",
            project: slug,
            target: logSrc,
            sha256: logDigest.sha256,
            bytes: logDigest.bytes,
            meta: { file: path.basename(logSrc), moved_to: `archive/${entry.date}-log.md`, rolled_into: summaryFile },
          });
        }
      }
      result.entriesArchived++;
    }

    result.weeksRolledUp++;
  }

  if (!dryRun && result.weeksRolledUp > 0) {
    updateIndex(slug);
  }

  return result;
}
