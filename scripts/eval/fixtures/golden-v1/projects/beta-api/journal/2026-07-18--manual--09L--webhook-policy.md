# 2026-07-18 — Webhook retry policy landed

## Decisions

Webhook retry policy merged: 5 retries, exponential backoff capped at 15 minutes, dead-letter table after that. Customer dashboard shows dead-lettered deliveries.

## Notes

Two customers asked for configurable retry counts — parked for now.
