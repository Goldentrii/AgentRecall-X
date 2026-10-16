# 2026-07-14 — Queue backend decision day

## Decisions

Job queue decision landed: Redis Streams won on operational simplicity over RabbitMQ — one less stateful service, consumer groups cover at-least-once, and Redis is already in our on-call surface.

## Work

Cutover plan drafted: shadow-consume for a week, then flip producers shard by shard. RabbitMQ decommission target end of July.

## Notes

Benchmark numbers archived in the decisions room (queue-backend).
