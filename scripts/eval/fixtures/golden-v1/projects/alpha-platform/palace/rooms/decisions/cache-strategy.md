---
tags: [cache, redis, ttl, memcached]
---

# Cache strategy: read-through Redis

## Decision (2026-08-02)

We ship a read-through Redis cache with a 300 second TTL for all product catalog reads. Memcached was rejected because we would lose persistence and the Streams-based invalidation bus we already run on Redis.

## Notes

- TTL started as a 900 second proposal during review; load tests showed stale pricing complaints above 300 seconds, so 300 is final.
- Invalidation: write path publishes to `cache:invalidate`, consumers delete keys.
