# Standing gates

## Deploy gate

Never deploy to production without explicit owner approval — confirmed 5x in retros; the one skipped approval (2026-06-30 hotfix) caused the only Sev-1 of the quarter.

## Migration gate

Database migrations require a rollback script reviewed in the same PR.
