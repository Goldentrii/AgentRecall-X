# Docker MCP catalog

State 2026-11-14: not listed (327 directories under `docker/mcp-registry/servers`, none with agent-recall; only `memory` and `neo4j-memory` match "memor"). Rules from `CONTRIBUTING.md` (fetched): remote servers need no Dockerfile; use `streamable-http` or `sse`; the PR adds `servers/<name>/server.yaml`, `tools.json` (always `[]` for remote) and `readme.md` (a documentation link); every PR is reviewed by the Docker team; licence MIT is fine; approved servers appear within about 24 hours.

Files are prepared in `docs/listings/docker/` (`server.yaml`, `tools.json`, `readme.md`).

## Submit

```
gh repo fork docker/mcp-registry --clone && cd mcp-registry
mkdir servers/agent-recall
cp <this repo>/docs/listings/docker/{server.yaml,tools.json,readme.md} servers/agent-recall/
task validate -- --name agent-recall
task build -- --tools agent-recall
```

Then open the PR with their `.github/PULL_REQUEST_TEMPLATE.md`. Icon URL in `server.yaml` is the raw GitHub URL of `assets/brand/icon-400.png` on main: it resolves only after the merge.

## Unknowns

- UNVERIFIED: whether `task validate` accepts our server without an `oauth:` block. The documented `oauth` entries use Docker's own provider list; a DCR server like ours is not described. Ask in the PR if validation complains.
- UNVERIFIED: allowed `category` values; `productivity` is used because it appears in their examples.
- Docker test credentials are shared through a form for servers needing them; ours is open sign-up with GitHub, so none should be needed.
