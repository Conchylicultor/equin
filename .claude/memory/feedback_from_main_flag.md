---
name: --from-main requires explicit approval
description: Never use ./equin push --from-main without the user explicitly approving it in the current conversation
type: feedback
originSessionId: f7e379d6-9f46-4015-ab53-4c2b1ec223bf
---
`./equin push --from-main` commits and pushes straight from main, bypassing the worktree-merge flow. Never pass this flag based on memory, prior sessions, or a general CLAUDE.md permission — the user must explicitly approve it in the current conversation, for this specific push.

**Why:** The normal flow (work in a worktree, merge into main) prevents branch conflicts between parallel agents and preserves the review step. `--from-main` exists only as an escape hatch for when the worktree detour would be pure churn, and misuse by an agent corrupts the safety invariant the whole workflow is built on.

**How to apply:** If you're on main with uncommitted changes and the user says "push", do NOT reach for `--from-main`. Stop and ask: "We're on main — do you want me to use `--from-main`, or should I move the changes into a worktree first?" Only pass the flag after they say yes in the current conversation.
