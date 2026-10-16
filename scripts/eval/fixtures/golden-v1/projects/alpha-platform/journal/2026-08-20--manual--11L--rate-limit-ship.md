# 2026-08-20 — Public API rate limit shipped

## Decisions

We shipped the public api rate limit at 250 rps per API key — load tests showed the proposed 100 rps throttled two legitimate beta integrations, so the final shipped value is 250 rps at the gateway.

## Work

Gateway config rolled to all regions; 429 responses carry a Retry-After header.
