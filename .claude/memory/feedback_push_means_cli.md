---
name: Push means equin push
description: When user says "push", always run ./equin push CLI — never raw git commit/push
type: feedback
originSessionId: 29321060-9217-4704-a699-988b5c80be2d
---
When the user says "push", always run `./equin push` — never do manual git add/commit/push.

**Why:** The CLI handles the full workflow (commit, ff-only merge to main, push). Manual git commands bypass this.

**How to apply:** Any time the user says "push" or "now push", run `./equin push` from the worktree.
