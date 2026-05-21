/**
 * Returns true if a filename is a "real" journal entry (not a capture log,
 * weekly rollup, index, or merged file). Use this everywhere readdirSync
 * scans journal directories.
 */
export function isJournalFile(filename: string): boolean {
  return (
    filename.endsWith(".md") &&
    filename !== "index.md" &&
    !filename.includes("-log.") &&
    !filename.includes("--capture--") &&
    !filename.endsWith(".merged.md") &&
    !/^\d{4}-W\d+/.test(filename)
  );
}
