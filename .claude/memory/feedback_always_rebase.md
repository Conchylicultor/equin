---
name: Always rebase, never merge
description: When integrating main into a branch, always rebase — never create a merge commit
type: feedback
originSessionId: ef3bdf4c-4406-4f92-b0e0-cabad173a09b
---
Always rebase, never merge. When a branch needs to integrate new main commits (e.g. after `./equin push` fails on rebase conflicts), use `git rebase origin/main` — not `git merge`.

**Why:** `./equin push` does a rebase internally, so any merge commit you create will just be rewritten/conflict again. Merge commits also preserve dead code (e.g. lines added in the branch commit, then deleted in the merge to adopt main's version) producing pure-churn history with no reader value.

**How to apply:** If `./equin push` fails with a rebase conflict, either:
1. `git rebase origin/main` and resolve conflicts, OR
2. `git reset --hard origin/main` + reapply changes as a fresh single commit (cleanest when main's shape changed enough that your original diff no longer makes sense).

Never use `git merge origin/main` on a feature branch.
