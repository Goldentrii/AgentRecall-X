# Contributing to AgentRecall

Thanks for your interest. AgentRecall is a correction-first memory system for AI agents — the goal is to make agents learn from mistakes and compound knowledge across sessions.

## Quick Start

```bash
git clone https://github.com/Goldentrii/AgentRecall-MCP.git
cd AgentRecall-MCP
npm install
npm run build
npm run lint
npm test
```

Requirements: Node.js ≥ 18, npm ≥ 9.

## Project Structure

```
packages/
  core/          # Storage, palace, awareness, corrections — the engine
  mcp-server/    # MCP tool definitions (wraps core)
  sdk/           # Public SDK for embedding AR in other tools
  cli/           # `ar` CLI (hook-start, hook-end, hook-correction, etc.)
docs/            # Architecture notes, upgrade guides, security audits
```

Most contributions touch `packages/core`. The MCP server is a thin wrapper — it mostly delegates to core logic.

## Before You Start

**Search for an existing issue first.** If you're fixing a bug or adding a feature, open (or find) an issue before sending a PR. This avoids duplicate work and lets us align on direction.

**Good first issues** are labeled [`good first issue`](https://github.com/Goldentrii/AgentRecall-MCP/issues?q=is%3Aissue+label%3A%22good+first+issue%22) on GitHub.

## Making Changes

1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Make your changes in the right package
3. Run `npm run build` to confirm TypeScript compiles
4. Run `npm run lint` to check TypeScript project references
5. Run `npm test` — all packages must pass (304 tests, 0 failures)
6. Add tests for new behavior — we use Node's built-in `node:test` runner (`.mjs` files)
7. Commit with a conventional message: `feat:`, `fix:`, `docs:`, `chore:`, `test:`

## Testing

```bash
npm test                        # all packages
npm test -w packages/core       # core only
npm run lint                    # TypeScript checks across packages
```

Tests are in `packages/core/test/*.test.mjs`. They use `node:test` and `node:assert/strict` — no Vitest or Jest.

**Key rule:** tests that touch the filesystem must use `process.env.AGENT_RECALL_ROOT` pointing to a `tmpdir()` — never write to `~/.agent-recall` in tests. See `corrections-e2e.test.mjs` for the pattern.

## What to Contribute

Areas where help is most welcome:

| Area | What's needed |
|------|--------------|
| **Adapters** | Import from Mem0, MemGPT, or other memory systems into `/arbootstrap` |
| **Embeddings** | Alternative embedding backends (OpenAI, local models) beyond pgvector |
| **Decay models** | Alternatives to Ebbinghaus+Zipf for insight salience decay |
| **CLI UX** | Better output formatting, interactive prompts |
| **Docs** | Real-world usage examples, tutorials, translated README sections |
| **Tests** | Coverage for edge cases in palace search and awareness rollup |

## Code Style

- TypeScript throughout — no `any`, use `unknown` for external input
- Exported functions need explicit parameter and return types
- No `console.log` in production code paths
- Zod for schema validation at MCP tool boundaries

## Updating UPDATE-LOG.md

If your change is substantial enough to warrant a version bump, add a row to the **Version History** table in `UPDATE-LOG.md` with:
- What changed
- Why it was needed
- How it was implemented

This is the canonical changelog.

## PR Checklist

- [ ] `npm run build` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes (0 failures)
- [ ] New behavior has tests
- [ ] `UPDATE-LOG.md` updated if this is a version-bump-worthy change
- [ ] No hardcoded paths to `~/.agent-recall` in tests

## Questions

Open a [GitHub Discussion](https://github.com/Goldentrii/AgentRecall-MCP/discussions) or file an issue. We respond to both.
