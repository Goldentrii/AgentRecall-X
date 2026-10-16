---
order: 1
phase: "auth-hardening"
status: "closed"
opened: "2026-07-01"
closed: "2026-08-12"
---

# Phase 0001 — Auth hardening

## Goal

Rotate all long-lived API keys to short-lived tokens and add audit logging to every auth decision.

## What was hard

Three legacy integrations pinned the old key format; migrating them required coordinated customer comms.

## How solved

Dual-accept window of 30 days with per-key usage telemetry to confirm the old format went silent before cutoff.

## Synthesis

Phase closed 2026-08-12. Dual-accept windows plus usage telemetry make credential migrations boring — reuse this pattern.
