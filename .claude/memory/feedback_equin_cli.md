---
name: Run the CLI after building
description: Always run ./equin build to deploy after making code changes, don't skip the CLI step
type: feedback
originSessionId: 6e28c106-c1b2-4e36-b8c0-650efe8a9cb6
---
After making code changes, always run `./equin build` to deploy. Don't skip this step.

**Why:** The deploy step (build frontend + server + register gateway) is required for the app to be available at `<name>.localhost:9000`. User was annoyed it was skipped.

**How to apply:** After finishing code changes in a worktree, always run `./equin build` before telling the user the work is done.
