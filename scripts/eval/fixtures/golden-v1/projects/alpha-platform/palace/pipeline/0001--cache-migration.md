---
order: 1
phase: "cache-migration"
status: "closed"
opened: "2026-06-28"
closed: "2026-08-30"
---

# Phase 0001 — Cache migration

## Goal

Move all catalog reads from the in-process LRU to the shared read-through Redis cache without a user-visible latency regression.

## What was hard

memcached eviction storms during dual-write — the interim dual-write window hammered the old memcached pool, evictions cascaded, and p99 briefly doubled until we capped dual-write to 10% of traffic.

## How solved

Staged the cutover by catalog shard, capped dual-write, and pre-warmed Redis from a nightly dump before each shard flip.

## Synthesis

Phase closed 2026-08-30. Dual-write windows need a traffic cap from day one; pre-warming turned the riskiest flip into a non-event. The 300s TTL decision (see decisions/cache-strategy) came out of this phase's load tests.
