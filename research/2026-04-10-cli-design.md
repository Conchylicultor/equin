# CLI Design

## Context

equin manages agents (Claude Code instances), each running in its own git worktree with its own server and frontend. Today, setting up a worktree is manual: create the git worktree, install deps, build the frontend, hand-write a registry JSON so the gateway discovers it. That's ~5 commands and easy to get wrong.

The CLI automates it. v1 scope: worktree lifecycle (`create`, `list`, `remove`) and platform health (`status`). No agent launching, no session tracking — those are v2.

## Language Decision: Bun/TS

| Factor | Bun/TS | Python |
|---|---|---|
| Runtime dependency | None new — server already uses Bun | Adds a third runtime |
| Type sharing | Import `WorktreeSpec`, registry schema, path conventions directly | Duplicate types or generate them |
| Agent self-improvement | Agents already understand the TS codebase | Context switch to a different ecosystem |
| CLI ergonomics | `Bun.spawn` for subprocesses, fast startup (~50ms), native TS | Excellent, but adds `pip`/`venv` complexity |

The CLI is thin orchestration — git commands, JSON files, spawning `bun build`. Not CPU-bound. No reason to bring in a second language.

Runs TypeScript directly via `bun cli/src/index.ts` — no build step.

## End-to-End Workflow

### Today (manual)

```
1. git worktree add ~/.singularity/agents/cli-design -b cli-design
2. cd ~/.singularity/agents/cli-design/web && bun install && bun run build
3. Hand-write ~/.singularity/worktrees/cli-design.json
4. Gateway auto-discovers → cli-design.localhost:9000 works
5. Open terminal in UI, run claude in the worktree
```

### With CLI (v1)

```
1. singularity wt create cli-design
   → git worktree add, bun install, bun build, write registry JSON
   → prints: ✓ cli-design.localhost:9000 ready

2. Open cli-design.localhost:9000 → equin UI for that worktree
3. Open terminal → Claude Code starts in the worktree
4. Agent works, commits, user reviews

5. singularity wt remove cli-design
   → removes registry JSON, git worktree, branch
```

### v2 (sketch — not designed here)

```
1. singularity spawn "Design the CLI"
   → creates worktree + launches Claude Code with --prompt
   → writes session record to ~/.singularity/sessions/
2. singularity agents
   → lists running agents with state (running, needs-review, completed)
3. singularity stop cli-design
```

## v1 Commands

### `singularity worktree create <name>` (alias: `wt create`)

Creates a git worktree, builds the frontend, registers with the gateway.

**Arguments:**

| Arg | Required | Description |
|---|---|---|
| `name` | yes | Worktree identifier. Must match `^[a-z0-9][a-z0-9-]{0,62}$` |

**Flags:**

| Flag | Default | Description |
|---|---|---|
| `--no-build` | false | Skip `bun install` + `bun build`. Points `web` at head's `web/dist` instead. |
| `--branch` | `<name>` | Git branch name. Defaults to the worktree name. |

**Steps:**

1. Validate name against regex
2. Check `~/.singularity/worktrees/<name>.json` doesn't already exist
3. Resolve main repo root (`git rev-parse --show-toplevel`)
4. `git worktree add ~/.singularity/agents/<name> -b <branch>`
5. If `--no-build`: set `webPath = <main-repo>/web/dist`
   Else: `cd ~/.singularity/agents/<name>/web && bun install && bun run build`, set `webPath = ~/.singularity/agents/<name>/web/dist`
6. Write `~/.singularity/worktrees/<name>.json`:
   ```json
   {
     "server": "/Users/admin/.singularity/agents/<name>/server",
     "web": "<webPath>"
   }
   ```
7. Print: `✓ <name>.localhost:9000 ready`

**`--no-build` rationale:** Full build takes ~30s+ (`bun install` + `vite build`). Most agent work is backend-only — these agents don't need their own frontend. With `--no-build`, the gateway serves head's built frontend but spawns the worktree's own backend. Creation drops from ~30s to ~2s. The agent can rebuild later if it touches frontend code.

**Error cases:**

| Condition | Behavior |
|---|---|
| Name fails regex | Exit 1, print validation error |
| Registry JSON exists | Exit 1, "worktree '<name>' already registered" |
| `git worktree add` fails | Exit 1, print git's error |
| `bun install` / `bun build` fails | Clean up (remove JSON, `git worktree remove`). Exit 1. |

### `singularity worktree list` (alias: `wt list`)

Two modes:

1. **Gateway reachable** (`GET http://head.localhost:9000/gateway/worktrees`): show live state.

```
NAME           STATE     PORT   CONNS   LAST-ACTIVITY
head           Running   9002   1       2s ago
cli-design     Idle      -      0       5m ago
```

2. **Gateway down**: fall back to reading `~/.singularity/worktrees/*.json` directly.

```
NAME           SERVER                                          WEB
head           server       ...web/dist
cli-design     ~/.singularity/agents/cli-design/server         ...web/dist
```

The gateway's response shape (from `gateway/worktree.go:58`):
```typescript
interface WorktreeStatus {
  name: string;
  state: string;       // "Idle" | "Starting" | "Running" | "Stopping" | "Broken"
  port: number;
  lastActivity: string; // ISO 8601
  activeConns: number;
  server: string;
  web: string;
}
```

### `singularity worktree remove <name>` (alias: `wt remove`)

**Safeguard:** Refuses to remove `head`.

**Steps:**

1. Check `~/.singularity/worktrees/<name>.json` exists
2. If `name === "head"` → exit 1
3. Delete the registry JSON (gateway's fsnotify tears down the backend)
4. `git worktree remove ~/.singularity/agents/<name>`
5. `git branch -d <name>` (best-effort — don't fail on unmerged changes)
6. Print: `✓ <name> removed`

`--force` flag: passes `--force` to `git worktree remove` if there are uncommitted changes.

### `singularity status`

```
Gateway:    ✓ running at :9000
Worktrees:  3 registered (2 idle, 1 running)
Head:       head.localhost:9000
```

Calls `GET /gateway/worktrees`. Falls back to file-based info if gateway is down.

## Package Structure

```
cli/
├── package.json          # @singularity/cli
├── tsconfig.json
└── src/
    ├── index.ts          # Entry: parse argv, dispatch to command
    ├── commands/
    │   ├── worktree-create.ts
    │   ├── worktree-list.ts
    │   ├── worktree-remove.ts
    │   └── status.ts
    └── lib/
        ├── worktree.ts   # Git worktree add/remove wrappers
        ├── registry.ts   # Read/write ~/.singularity/worktrees/*.json
        ├── build.ts      # Run bun install + bun build
        ├── gateway.ts    # HTTP client for /gateway/worktrees
        └── paths.ts      # Standard paths (~/.singularity/*)
```

### How it fits

```
┌─────────┐     file write      ┌────────────────────────────────┐
│   CLI   │ ──────────────────> │ ~/.singularity/worktrees/*.json │
└─────────┘                     └───────────────┬────────────────┘
                                                │ fsnotify
                                                v
                                        ┌──────────────┐
                                        │   Gateway     │ :9000
                                        └──────┬───────┘
                                               │ lazy-spawns
                                               v
                                        ┌──────────────┐
                                        │   Backend     │ :PORT
                                        └──────────────┘
```

The CLI and gateway communicate through the filesystem, not RPC. The CLI writes a JSON file; the gateway's fsnotify watcher picks it up. The CLI can also *read* gateway state via `GET /gateway/worktrees` for richer output, but never depends on it.

### Argument parsing

No framework. `process.argv` is sufficient for 4 commands:

```typescript
const [cmd, sub] = process.argv.slice(2);

if (cmd === "worktree" || cmd === "wt") {
  switch (sub) {
    case "create": return worktreeCreate(process.argv.slice(4));
    case "list":   return worktreeList();
    case "remove": return worktreeRemove(process.argv.slice(4));
  }
}
if (cmd === "status") return status();

printUsage();
```

`wt` as alias for `worktree` — it will be typed hundreds of times. If the command set grows past ~8, adopt a library. Not before.

### `paths.ts`

```typescript
import { homedir } from "os";
import { join } from "path";

const SINGULARITY_HOME = join(homedir(), ".singularity");

export const paths = {
  home:          SINGULARITY_HOME,
  worktrees:     join(SINGULARITY_HOME, "worktrees"),
  agents:        join(SINGULARITY_HOME, "agents"),
  worktreeJson:  (name: string) => join(SINGULARITY_HOME, "worktrees", `${name}.json`),
  agentDir:      (name: string) => join(SINGULARITY_HOME, "agents", name),
};
```

### `registry.ts`

Matches the gateway's `Spec` type (`gateway/worktree.go:51`):

```typescript
interface WorktreeSpec {
  server: string;  // absolute path
  web: string;     // absolute path
}
```

Functions: `readSpec(name)`, `writeSpec(name, spec)`, `removeSpec(name)`, `listSpecs()`.

### `package.json`

```json
{
  "name": "@singularity/cli",
  "private": true,
  "type": "module",
  "bin": {
    "singularity": "src/index.ts"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "~5.8.3"
  }
}
```

No runtime dependencies. `bun link` in `cli/` makes `singularity` available globally.

## Implementation Sequence

Each step leaves the CLI in a runnable state.

1. **Scaffold** — `package.json`, `tsconfig.json`, `src/index.ts` with usage printer. Verify: `bun cli/src/index.ts` prints help.
2. **`paths.ts` + `registry.ts`** — path conventions and JSON read/write.
3. **`worktree.ts` + `build.ts`** — git worktree and build wrappers.
4. **`worktree-create.ts`** — full create command with `--no-build`. Verify: `singularity wt create test-1 --no-build` completes in <3s, `test-1.localhost:9000` loads (with gateway running).
5. **`gateway.ts` + `worktree-list.ts`** — gateway API client and list command. Verify: works in both gateway-up and gateway-down modes.
6. **`worktree-remove.ts`** — cleanup command. Verify: removes JSON, git worktree, branch.
7. **`status.ts`** — platform health.
8. **Root `CLAUDE.md` update** — change `cli/` from "Agent CLI (Python, future)" to actual description. Add `cli/CLAUDE.md`.

## Critical Files

**To create:**
- `cli/package.json`
- `cli/tsconfig.json`
- `cli/src/index.ts`
- `cli/src/commands/worktree-create.ts`
- `cli/src/commands/worktree-list.ts`
- `cli/src/commands/worktree-remove.ts`
- `cli/src/commands/status.ts`
- `cli/src/lib/paths.ts`
- `cli/src/lib/registry.ts`
- `cli/src/lib/worktree.ts`
- `cli/src/lib/build.ts`
- `cli/src/lib/gateway.ts`
- `cli/CLAUDE.md`

**To modify:**
- `CLAUDE.md` — update `cli/` description

**Reference (read, don't modify):**
- `gateway/worktree.go:51-66` — `Spec` and `WorktreeStatus` types
- `gateway/proxy.go:158` — `/gateway/worktrees` endpoint
- `gateway/registry.go` — fsnotify watcher, filename validation regex

## Verification

```sh
# 1. Link the CLI
cd cli && bun link

# 2. Create a worktree (fast mode)
singularity wt create test-agent --no-build
# ✓ test-agent.localhost:9000 ready

# 3. Verify registry file
cat ~/.singularity/worktrees/test-agent.json
# { "server": "...", "web": "..." }

# 4. List worktrees (gateway running)
singularity wt list
# NAME          STATE    PORT   CONNS   LAST-ACTIVITY
# head          Running  9002   1       2s ago
# test-agent    Idle     -      0       -

# 5. Open in browser
open http://test-agent.localhost:9000
# → equin UI loads

# 6. Check status
singularity status
# Gateway:    ✓ running at :9000
# Worktrees:  2 registered (1 idle, 1 running)

# 7. Clean up
singularity wt remove test-agent
# ✓ test-agent removed

# 8. Verify gone
singularity wt list
# NAME   STATE    PORT   CONNS   LAST-ACTIVITY
# head   Running  9002   1       2s ago
```
