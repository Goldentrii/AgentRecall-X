---
name: No version inflation
description: User corrected version bumping behavior
type: feedback
---

Never bump version numbers above what's needed. User corrected: proposed 4.0.0 for patch, corrected to 3.3.4. Conservative versioning is a non-negotiable.

**Why:** User cares about semver discipline. Version inflation signals poor judgment.
**How to apply:** Patch fix → patch bump. New feature → minor bump. Breaking change → major bump. Never more.
