---
tags: [dashboard, frontend, wizard, ux]
---

# Dashboard page redesign — wizard flow

## Decision (2026-08-15)

The dashboard page redesign replaces the settings grid with a three-step wizard. Shipped behind the `dash_v2` flag.

## Known gap

The wizard state is lost on refresh — known gap, accepted for v1 because state lives only in component memory; persisting draft state to localStorage is tracked as follow-up work.
