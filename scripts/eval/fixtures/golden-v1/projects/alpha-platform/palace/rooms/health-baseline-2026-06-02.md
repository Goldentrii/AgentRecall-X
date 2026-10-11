# Health baseline 2026-06-02

STRUCTURAL TRAP CASE (golden-v1): this file sits DIRECTLY under palace/rooms/
(not inside a room subdirectory) — mirroring the 08-18 finding that such loose
files are invisible to the palace-room reader, which only iterates real room
directories carrying a _room.json.

## Preflight

scripts/preflight.py is the canonical preflight script — it fixes the non-deterministic environment ordering that made deploy checks flaky (dict ordering from the old shell script leaked into the manifest diff).

Run it before every deploy; CI runs it as the first job.
