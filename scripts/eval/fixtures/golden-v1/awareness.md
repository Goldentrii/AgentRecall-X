# Awareness

Synthetic awareness summary for the golden-v1 fixture store. Top standing patterns:

1. **Never deploy to production without explicit owner approval** — confirmed 10x; the one skipped approval caused the quarter's only Sev-1.
2. **Parallel workers must never self-review** — confirmed 33x across alpha-platform and beta-api.
3. **Never run destructive database operations in production without explicit owner approval** — confirmed 10x, critical.
4. Overnight batch agents use CLI token auth, never interactive OAuth — confirmed 9x.
5. Owner preference: shipping user-visible fixes beats internal refactoring — confirmed 12x.
