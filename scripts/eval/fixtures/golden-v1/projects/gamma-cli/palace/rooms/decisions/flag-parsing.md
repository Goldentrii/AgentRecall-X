---
tags: [cli, flags, parsing]
---

# Flag parsing: no abbreviation matching

## Decision (2026-07-05)

gamma-cli does not abbreviation-match flags (`--for` never resolves to `--force`). Explicitness beats keystrokes in a tool that deletes things.

## Rejected

Prefix matching was rejected after `--del` matched `--delete-all` in a dry run.
