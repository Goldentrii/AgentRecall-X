---
order: 1
phase: "packaging"
status: "closed"
opened: "2026-06-25"
closed: "2026-07-20"
---

# Phase 0001 — Packaging

## Goal

Single-binary releases for the three desktop platforms with reproducible builds.

## What was hard

Code signing on two platforms required separate cert chains and CI secrets hygiene.

## How solved

Isolated signing into a dedicated CI job with scoped secrets; checksums published next to every artifact.

## Synthesis

Phase closed 2026-07-20. Reproducible-build checksums caught one toolchain drift within a week of shipping.
