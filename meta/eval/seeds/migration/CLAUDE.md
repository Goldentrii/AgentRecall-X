# Project: novada-mcp

## Key Rules
- Never publish to npm without explicit approval
- Test before every publish: npm test must be green
- Use Sonnet for workers, Opus for architecture decisions
- Keep local files — never delete after git push

## Architecture
- 4-package monorepo: core, mcp-server, sdk, cli
- Tests live in packages/*/test/
- Build: npm run build (root)

## Current Focus
- Beat Firecrawl on scraping quality
- Fix SERP 404 (assigned to fudong)
