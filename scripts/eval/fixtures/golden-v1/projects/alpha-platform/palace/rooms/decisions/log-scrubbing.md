---
tags: [logging, secrets, security, pipeline]
---

# Worker log pipeline scrubs secrets before persisting

## Decision (2026-07-08)

The worker log pipeline scrubs bearer tokens and sk- keys before any line is persisted to disk or shipped to the aggregator. Scrubbing runs in the worker process itself, not in the collector, so a crashed collector can never leak raw lines.

## Incident that forced this

On 2026-07-05 a staging worker logged a payment provider sk- key verbatim. The key was rotated the same day. The scrub list is a regex allowlist in `logscrub.rules`, reviewed on every change.
