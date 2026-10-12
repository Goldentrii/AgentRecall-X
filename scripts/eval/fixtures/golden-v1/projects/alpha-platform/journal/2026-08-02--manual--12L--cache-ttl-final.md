# 2026-08-02 — Cache TTL finalized

## Decisions

Catalog cache TTL is final at 300 seconds; the earlier 900 second proposal is superseded after load tests showed stale pricing complaints above 300. Read-through Redis cache config merged.

## Work

Invalidation bus consumers deployed to all three regions.
