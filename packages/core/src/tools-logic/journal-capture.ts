import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { journalDir, sanitizeSlug, sanitizeProject } from "../storage/paths.js";
import { ensureDir, todayISO } from "../storage/fs-utils.js";
import { withLock } from "../storage/filelock.js";
import { countLogEntries, regenerateJournalIndex } from "../helpers/journal-files.js";
import { detectContentType, extractKeywords } from "../helpers/auto-name.js";
import { ensurePalaceInitialized, roomExists, createRoom } from "../palace/rooms.js";
import { palaceDir } from "../storage/paths.js";
import { fanOut } from "../palace/fan-out.js";
import { updatePalaceIndex } from "../palace/index-manager.js";
import { captureLogFileName } from "../storage/session.js";
import { generateFrontmatter } from "../palace/obsidian.js";
import { scrubForCloud } from "../storage/content-guard.js";

export interface JournalCaptureInput {
  question: string;
  answer: string;
  tags?: string[];
  palace_room?: string;
  project?: string;
}

export interface JournalCaptureResult {
  success: boolean;
  entry_number: number;
  palace: { room: string } | null;
  auto_tags?: string[];
  /** Exact path of the capture log file written */
  file_path: string;
}

export async function journalCapture(input: JournalCaptureInput): Promise<JournalCaptureResult> {
  const slug = await resolveProject(input.project);
  const date = todayISO();
  const dir = journalDir(slug);
  ensureDir(dir);

  // Auto-tag: generate tags from content when none provided
  let autoTags: string[] | undefined;
  if (!input.tags || input.tags.length === 0) {
    const combined = `${input.question} ${input.answer}`;
    const type = detectContentType(combined);
    const kws = extractKeywords(combined, 2);
    input.tags = [type, ...kws];
    autoTags = input.tags;
  }

  // Session-safe log filename: avoids conflicts when multiple sessions capture simultaneously
  // Pass opts so captureLogFileName uses the new smart-naming format.
  //
  // W2-4 (naming-v2 spec §5): captureLogFileName has the SAME same-day
  // decide-then-write shape as journalFileName (session.ts) — an internal
  // readdirSync "does today's capture log already exist?" scan, followed by
  // the caller's read-existing + write. Wrap the decision + write in the
  // SAME per-project-per-store lock pattern used in journal-write.ts (reused
  // filelock mechanism, not a new one), so two near-simultaneous captures
  // can't each decide "no log yet" and create two divergent log files.
  // Lock key case-normalized via sanitizeProject — same rationale as
  // journal-write.ts: case-variant slugs share one dir, so one lock.
  const { logPath, entryNum } = withLock(`journal-capture-day-${sanitizeProject(slug)}`, () => {
    const combined = `${input.question} ${input.answer}`;
    const baseLogPath = path.join(dir, `${date}-log.md`);
    const logFileName = captureLogFileName(date, fs.existsSync(baseLogPath), {
      saveType: "capture",
      content: combined,
    }, dir);
    const lp = path.join(dir, logFileName);
    const num = countLogEntries(lp) + 1;
    const tagStr = input.tags && input.tags.length > 0 ? ` [${input.tags.join(", ")}]` : "";
    const timestamp = new Date().toISOString().slice(11, 19);

    // Wave 2 note: capture is the CURATED stream — these 2000/5000 caps are
    // intentional. The lossless tier is journal/archive/raw (verbatim, uncapped);
    // do not remove these caps to "preserve everything" — that is the raw tier's job.
    const question = input.question.length > 2000 ? input.question.slice(0, 2000) + "..." : input.question;
    const answer = input.answer.length > 5000 ? input.answer.slice(0, 5000) + "..." : input.answer;
    let entry = `### Q${num} (${timestamp})${tagStr}\n\n`;
    entry += `**Q:** ${question}\n\n`;
    entry += `**A:** ${answer}\n\n`;
    // Scrub BEFORE the local write — remember()'s capture path feeds recall();
    // this log had no scrub of any kind previously.
    entry = scrubForCloud(entry);

    if (!fs.existsSync(lp)) {
      // Obsidian-compatible frontmatter for new capture logs
      const fm = generateFrontmatter({
        type: "capture-log",
        project: slug,
        date,
        tags: ["capture", slug],
        created: new Date().toISOString(),
      });
      const header = `${fm}# ${date} — ${slug} — Session Log\n\n`;
      fs.writeFileSync(lp, header + entry, "utf-8");
    } else {
      fs.appendFileSync(lp, entry, "utf-8");
    }
    return { logPath: lp, entryNum: num };
  });

  // Index regeneration runs AFTER the lock is released (derived state,
  // last-writer-wins — naming-v2 spec §5).
  regenerateJournalIndex(slug);

  let palaceResult: JournalCaptureResult["palace"] = null;
  // Trim-guard for consistency with journal-write/palace-write (the try/catch below
  // would swallow the createRoom throw anyway, but skip the no-op work cleanly).
  if (input.palace_room && input.palace_room.trim()) {
    try {
      ensurePalaceInitialized(slug);
      if (!roomExists(slug, input.palace_room)) {
        createRoom(slug, input.palace_room, input.palace_room.charAt(0).toUpperCase() + input.palace_room.slice(1), "Auto-created from capture", []);
      }

      const pd = palaceDir(slug);
      const safeRoom = sanitizeSlug(input.palace_room);
      const targetPath = path.join(pd, "rooms", safeRoom, "captures.md");
      ensureDir(path.dirname(targetPath));

      const captureEntry = scrubForCloud(`\n### Q${entryNum} (${date})\n**Q:** ${input.question}\n**A:** ${input.answer}\n`);
      if (fs.existsSync(targetPath)) {
        fs.appendFileSync(targetPath, captureEntry, "utf-8");
      } else {
        fs.writeFileSync(targetPath, `# ${input.palace_room} / captures\n${captureEntry}`, "utf-8");
      }

      fanOut(slug, input.palace_room, "captures", `${input.question} ${input.answer}`, [], "medium");
      updatePalaceIndex(slug);
      palaceResult = { room: input.palace_room };
    } catch {
      // Palace integration is optional
    }
  }

  return { success: true, entry_number: entryNum, palace: palaceResult, auto_tags: autoTags, file_path: logPath };
}
