# 2026-07-05 — Flag parsing decision

## Decisions

No abbreviation matching for flags, ever. `--for` stays an error instead of resolving to `--force`. Documented in the decisions room.

## Work

Parser updated; error messages now suggest the nearest full flag name.
