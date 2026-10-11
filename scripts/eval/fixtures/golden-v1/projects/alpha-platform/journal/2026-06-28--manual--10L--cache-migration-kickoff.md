# 2026-06-28 — Cache migration kickoff

## Summary

Opened the cache migration phase today — status: in progress. Scope: move catalog reads off the in-process LRU onto shared Redis. The cache migration phase is in progress until every shard is flipped; tracking in the pipeline doc.

## Risks

Dual-write load on the old memcached pool during the transition window.
