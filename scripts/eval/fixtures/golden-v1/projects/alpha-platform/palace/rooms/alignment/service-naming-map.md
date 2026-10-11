---
tags: [naming, ingestion, canonical]
---

# Service naming — canonical map

## Canonical names (2026-07-22)

The ingestion service canonical name is alpha-ingest. It was renamed from alpha-collector on 2026-07-22; alpha-collector remains only as a deprecated DNS alias until Q4.

This is a cross-project naming problem: beta-api and gamma-cli docs still say alpha-collector in places — always correct them to alpha-ingest.

| Service | Canonical | Deprecated aliases |
|---|---|---|
| ingestion | alpha-ingest | alpha-collector |
| gateway | alpha-gw | edge-proxy |
