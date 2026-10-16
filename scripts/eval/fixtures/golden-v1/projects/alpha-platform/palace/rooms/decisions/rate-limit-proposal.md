---
tags: [rate-limit, api, proposal]
---

# Proposal: public API rate limit

## Proposal (2026-06-10)

For the public api launch we propose a rate limit of 100 rps per API key, enforced at the gateway. 100 rps covers the 95th percentile of beta traffic with 4x headroom.

## Status

Proposed for review. Final number to be confirmed by load testing before ship.
