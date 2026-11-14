# AgentRecall listings

Prepared 2026-11-14. Nothing here has been submitted. Every "state" below was checked today by fetching the directory itself; where a fetch failed the cell says UNVERIFIED and what was tried. The owner submits; paste-ready values are in `submissions/`, the single source for the text is `fields.json`.

Positioning for every listing: AgentRecall closes the Intelligent Distance between a person and their agents: a correction you give one agent reaches every connected agent. It is never described as plain memory storage.

## Ranked by value for effort

| # | Directory | State today (2026-11-14) | Method | Owner does by hand | Time | Blocking requirements we do not meet yet |
|---|---|---|---|---|---|---|
| 1 | Official MCP Registry | Listed, stale: `io.github.Goldentrii/agent-recall` v3.5.2 is latest, remote still `recall.aiakada.com/mcp` (the old host); description current | `mcp-publisher` CLI | `mcp-publisher login github`, `mcp-publisher publish` | 5 min | npm has 3.5.2, not 3.5.3; `server.json` pins 3.5.3, so publishing before `npm publish` will be rejected. See `submissions/official-mcp-registry.md` | <!-- OLD-HOST -->
| 2 | Claude connectors directory | Not listed (not searched in-product; no public listing URL exists) | Developer portal, `claude.ai/directory/manage`, "MCP connector" | Fill 10 portal steps, paste fields | 45 min | Public support contact; docs URL is ready. Verified review (human) needs a reviewer test account. See `submissions/claude-connectors.md`, `BLOCKERS.md` |
| 3 | punkpeye/awesome-mcp-servers | Listed but stale: entry says `Goldentrii/AgentRecall` with the old `AgentRecall-MCP` Glama badge | PR editing one line of README.md | Fork, edit, PR (star the repo first is a rule for the remote list) | 10 min | None. Merge of our repo to main so links resolve |
| 4 | Cline MCP marketplace | Not listed (no issue for AgentRecall in `cline/mcp-marketplace`; 53 memory-related issues seen, none ours) | GitHub issue with template | Test the install in Cline, open the issue | 20 min | The Cline test run must be done by the owner; `llms-install.md` is ready |
| 5 | Cursor marketplace | Not listed | Plugin submitted at `cursor.com/marketplace/publish`; manual review | Merge branch to main, submit repo | 15 min | `.cursor-plugin/plugin.json` + `mcp.json` must be on the default branch. Plugin schema page fetched; no JSON Schema file found (UNVERIFIED) |
| 6 | mcpservers.org | Not listed (UNVERIFIED: site has no search I could fetch; form fetched) | Web form, free tier reviewed in about 2 weeks | Fill form | 10 min | Contact email (owner's) |
| 7 | mcp.so | Not listed (fetched search page: no match) | Web form `mcp.so/submit` | Fill form (repo URL, name, type "Remote Server") | 10 min | The page shows one tier: $39 one-time, publishes without review. No free tier visible today (the 2026-11-13 plan assumed one). Owner decides whether to pay |
| 8 | Glama | Listed, unclaimed: `glama.ai/mcp/servers/Goldentrii/AgentRecall-X`, hosted option text shows the old host `recall.aiakada.com`, TDQS 3.9/5 | Claim button on the listing (GitHub sign-in); `glama.json` in repo | Sign in with GitHub, claim, re-sync | 10 min | Claim flow not fetchable (claim URL 404). The old host text is scraped from README and will refresh on re-sync | <!-- OLD-HOST -->
| 9 | Docker MCP catalog | Not listed (no `agent-recall` in `docker/mcp-registry/servers`, 327 entries) | PR to `docker/mcp-registry`; Docker team reviews every PR | Fork, copy `docker/`, run `task validate`, PR | 30 min | UNVERIFIED that the validator accepts a remote DCR-OAuth server with no `oauth:` block |
| 10 | ChatGPT apps | Not listed | OpenAI developer portal, human review | Many steps | days | Organisation verification, domain proof file, terms URL, 5+3 test cases, demo video, MFA-free test account, ChatGPT OAuth callback not in our redirect allowlist. See `BLOCKERS.md` |
| 11 | punkpeye/awesome-remote-mcp-servers | Not listed (0 matches in README) | PR | Star repo, PR | 15 min | Must be "listed as a Glama connector" with a badge: depends on row 8. Auth marker 🔐 |
| 12 | GitHub MCP Registry (`github.com/mcp`) | Not listed (790 servers; search for agent-recall found none) | UNVERIFIED: no submission process in GitHub docs fetched | Nothing known | n/a | Relationship to the official registry not documented in what I could fetch. Do row 1 and re-check |
| 13 | VS Code MCP gallery | `aka.ms/vscode-mcp-registry-web` redirects to `github.com/mcp`: same catalog as row 12 | Same as row 12 | Nothing | n/a | Same as row 12 |
| 14 | PulseMCP | Listed, stale: `goldentrii-agent-recall`, text says "local-only", release Mar 24 2026 | None: submissions and listing changes paused (page updated 2026-09-03); it says it will ingest from the official registry | Nothing | 0 | Do row 1 and wait |
| 15 | Smithery | Not listed in its directory (search for agent recall: no match). **Closed**: proxy, CLI, SDKs and accounts shut down 2026-10-31; smithery.ai is now a directory run by Arcade | None available. `smithery.yaml` is legacy | Nothing | 0 | Platform change, not ours. One third-party repo claims new registrations are blocked; the Smithery notice does not say whether third parties can still list (UNVERIFIED) |
| 16 | LobeHub MCP marketplace | UNVERIFIED: `lobehub.com/mcp` redirected to `market.lobehub.com/s/plugins`; docs page showed only a CLI (`@lobehub/market-cli mcp search`), no submission process and no catalog data | Unknown | Run `npx -y @lobehub/market-cli mcp search --q agent-recall` to see state | 5 min | Method unknown |
| 17 | cursor.directory | UNVERIFIED: fetch returned HTTP 429 | Unknown | Check `cursor.directory/mcp` for a submit route | 5 min | Method unknown |
| 18 | Windsurf (now Devin Local) | No public marketplace submission process found. Its docs say custom registries must follow the official MCP registry schema | Inherits from row 1 | Nothing | 0 | None |
| 19 | Zed extensions | Skip. Zed docs: it plans to deprecate MCP server extensions in favour of the official MCP registry; remote servers are added in the UI | Inherits from row 1 | Nothing | 0 | Extension needs Rust code; not worth it |
| 20 | Continue | No hub/marketplace publishing process found in the docs (UNVERIFIED: `hub.continue.dev` does not resolve). Users paste an `mcpServers` block | Docs only | Optionally add a Continue snippet to `/connect.md` | 10 min | None |
| 21 | Claude plugin directory | Not listed. The connectors docs say local servers can only be distributed through a plugin (`claude.com/docs/plugins/submit.md`, not fetched: UNVERIFIED) | Plugin submission | Out of scope for this pass | n/a | Needs a plugin package |
| 22 | npm discoverability (`agent-recall-mcp`, `-cli`, `-sdk`, `-core`) | Published 3.5.2 with the old description ("Memory Palace MCP server for AI agents"); the four package descriptions already carry the positioning on main (PR #69) and ship with the next release | `description` + `keywords` in package.json (done on main), README | Change description at the next release | 5 min | Needs a release (version bump needs owner yes) |

Rows 12 to 22 are not worth a dedicated submission: they inherit from row 1 or have no open door.

## What is in the repo for these directories

| File | Read by | Valid against |
|---|---|---|
| `packages/mcp-server/server.json` | Official MCP Registry | `2025-12-11` schema URL it declares; `remotes[]` type and url, 100 char description rule checked by the existing test |
| `glama.json` | Glama | `https://glama.ai/mcp/schemas/server.json`: only `maintainers` (required), fetched today; valid, unchanged |
| `smithery.yaml` | Nothing (platform closed) | UNVERIFIED (schema page 404); fixed the wrong tool count |
| `.cursor-plugin/plugin.json`, `mcp.json` | Cursor marketplace | Cursor "Plugins reference" rules (kebab-case name, relative logo path, semver); no JSON Schema file published that I could fetch (UNVERIFIED) |
| `llms-install.md` | Cline | Cline README: optional file; format is free text |
| `docs/listings/docker/*` | Docker MCP registry (copy into a fork) | CONTRIBUTING remote format; `task validate` not run (needs their repo) |
| `assets/brand/icon-400.png`, `icon-512.png` | Cline (400x400), Claude (icon), Docker, Cursor logo | Exact sizes checked by the drift test |
| `docs/listings/fields.json` | Source for all pasted text | Length limits checked by the drift test |

Run `node --test scripts/listings-drift.test.mjs` after any version or URL change.

## Order of work for the owner

1. Merge this branch to main (links and icon URLs resolve only on main).
2. Release 3.5.3 to npm (your yes), then `mcp-publisher publish`: row 1. Rows 14, 12, 13, 18 follow.
3. Rows 2, 3, 4, 5 on the same day.
4. Row 8 then row 11. Rows 6, 7, 9 when convenient. Row 10 only after `BLOCKERS.md` is closed.
