import { formatAgo, readEvents, readHeads, verifyLedger } from "agent-recall-core";

/**
 * One-line ledger summary appended to session_start text. Read-only and total:
 * any ledger failure renders as "lifecycle: unavailable (<reason>)" so
 * session_start never fails because of the ledger.
 */
export function lifecycleLine(slug: string, root?: string): string {
  try {
    const h = readHeads(root)[slug];
    if (!h) return `lifecycle: no ledger events yet (run: ar ledger backfill --project ${slug})`;
    const last = readEvents({ project: slug, limit: 1 }, root)[0];
    if (!last) return `lifecycle: no ledger events yet (run: ar ledger backfill --project ${slug})`;
    const v = verifyLedger(slug, root);
    const born = h.first_ts.slice(0, 10);
    const verify = v.errors === 0 ? (v.warnings > 0 ? `clean (${v.warnings} warn)` : "clean") : `${v.errors} findings`;
    return `lifecycle: born ${born} · ${h.count} events · last ${last.type} ${formatAgo(last.ts)} via ${last.via} · verify: ${verify}`;
  } catch (err) {
    return `lifecycle: unavailable (${err instanceof Error ? err.message : String(err)})`;
  }
}
