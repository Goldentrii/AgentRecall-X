---
tags: [queue, redis, rabbitmq, infrastructure]
---

# Job queue backend: Redis Streams

## Decision (2026-07-14)

For the background job queue we evaluated RabbitMQ and Redis Streams. Redis Streams won on operational simplicity: one less stateful service to run, consumer groups give us at-least-once delivery, and we already operate Redis for the cache.

## Rejected

RabbitMQ was rejected: better routing features, but a second clustered service to patch and monitor was not worth it at our queue depth (peak 4k msgs/min).

## Consequences

- Dead-letter handling is hand-rolled via a `jobs:dead` stream.
- Replays use `XRANGE` snapshots, documented in the runbook.
