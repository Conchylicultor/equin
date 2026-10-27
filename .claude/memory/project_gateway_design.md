---
name: Gateway multi-worktree routing
description: Critical design — gateway multiplexes multiple app instances (one per agent worktree) behind port 9000, abstracting away individual ports
type: project
originSessionId: ec7e9cc8-9807-4392-abc3-3c6ac653d93e
---
The gateway is a reverse proxy on port 9000 that routes to multiple app instances, one per agent worktree.

In v1, the architecture was:
- `.equin build` compiled web+server and wrote output paths to `.equin/worktrees/<worktree>/paths.json`
- Gateway watched those files and assigned ports internally
- URLs: `localhost:9000/head/` (stable), `localhost:9000/<worktree>/` (agent work)
- Gateway rewrote `localhost:9000/<worktree>/api/todos` → `localhost:<internal-port>/api/todos`
- Edge cases were tricky: fetch, RPC, WebSocket all needed correct routing

**Why:** This is core to the product — agents work in isolated worktrees and users switch between instances to inspect/validate agent work before merging.

**How to apply:** Any networking/routing decision must account for this multi-instance topology. The frontend must never hardcode ports. The gateway is the single entry point.

**Note on v1 constraint:** v1 used path-prefix routing only because the core app was owned by another team and could not be modified. In equin the user owns the whole stack, so subdomain routing (`<worktree>.localhost:9000`) is viable and strongly preferred — it avoids the base-path tax entirely.
