# 2026-09-01 — Retry storm reflection

## Reflection

The retry storm failure class has recurred twice after the exponential backoff fix — both times via a NEW client bypassing the shared SDK, not via the fixed path. Lesson: the fix lives in the SDK, enforcement has to live at the gateway.

## Corrections review

The friday migration correction has now recurred twice as well (2026-08-07 and 2026-08-28 deploys) — the stored correction record still shows zero, the narrative count here is authoritative.

## Action

Gateway-level retry budget proposal drafted.
