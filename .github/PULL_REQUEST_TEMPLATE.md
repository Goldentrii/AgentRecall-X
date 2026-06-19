<!-- Thanks for contributing to AgentRecall! Please fill this in. -->

## What & why
<!-- What does this change do, and what problem does it solve? -->

## How verified
<!-- Commands you ran and their results. CI must be green to merge. -->
- [ ] `npm run build` passes
- [ ] Regression suites pass (`node benchmark/{consistency,funnel,heeded-guard,room-slug-guards}.mjs`)
- [ ] Added/updated a test for this change

## Checklist
- [ ] **No version bump** (maintainer handles releases)
- [ ] No unrelated changes / no formatting-only churn mixed with logic
- [ ] No secrets, API keys, or telemetry added
- [ ] MCP string inputs that reach `path.join` / `RegExp` / `fs.*` are constrained (regex or allowlist)
- [ ] Docs updated if behavior changed (`UPDATE-LOG.md`, README)

## Notes for the maintainer
<!-- Anything to be aware of when reviewing / risks / follow-ups. -->
