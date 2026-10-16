---
tags: [webhooks, retry, api]
---

# Webhook delivery retry policy

## Decision (2026-07-18)

Webhook deliveries retry 5 times with exponential backoff capped at 15 minutes, then land in a dead-letter table surfaced in the customer dashboard. Consumers must treat deliveries as at-least-once.

## Rejected

Infinite retry was rejected — a dead endpoint would hold a worker slot forever.
