# CLI `singularity build` Command

## Context

Agents work in git worktrees created by `EnterWorktree`. After making code changes, they need a single command to install dependencies, build the frontend, and register with the gateway so the worktree becomes accessible at `<name>.localhost:9000`. The `singularity build` command is this command — the first piece of the CLI, built with Commander.js.

## Worktree Name Detection

The name comes from `path.basename(gitTopLevel)` — when the agent is in `.worktrees/my-feature/`, the basename is `my-feature`. Validated against `^[a-z0-9][a-z0-9-]{0,62}$` (matches the gateway's `nameRegex`).

## Build Steps (in order)

1. `git rev-parse --show-toplevel` → get worktree root
2. Extract and validate name from basename
3. `bun install` in worktree root (worktrees don't have node_modules)
4. `bun run build` in `<root>/web/` (runs `tsc -b && vite build` → `web/dist/`)
5. `mkdir -p ~/.singularity/worktrees/`
6. Write `~/.singularity/worktrees/<name>.json`:
   ```json
   {
     "server": "<root>/server",
     "web": "<root>/web/dist"
   }
   ```
7. Print: `Deployed to <name>.localhost:9000`

Subprocess output is inherited (stdout/stderr passthrough). Any non-zero exit aborts immediately.

## Files to Create

```
cli/
├── package.json          # @singularity/cli, depends on commander
├── tsconfig.json
└── src/
    ├── index.ts          # Commander program, registers build command
    └── commands/
        └── build.ts      # Build command implementation
```

### `cli/package.json`

- Name: `@singularity/cli`, private, type: module
- Dependency: `commander`
- No build scripts — runs directly via `bun cli/src/index.ts`

### `cli/src/index.ts`

Commander program setup. Name `singularity`, registers `build` subcommand, calls `program.parse()`.

### `cli/src/commands/build.ts`

Exports a function that takes the Commander program and registers a `build` command. Implementation:
- `Bun.spawn` for `bun install` and `bun run build` (inherit stdio)
- `await proc.exited` for exit codes
- `fs.mkdirSync` with `recursive: true` for registry dir
- `fs.writeFileSync` for the JSON

## Files to Modify

### `package.json` (root)

Add `"cli"` to workspaces: `["web", "server", "plugin-core", "plugins/*", "cli"]`

### `CLAUDE.md` (root)

1. **Folder structure**: Change `cli/` line from "Agent CLI (Python, future)" to "Agent CLI (TypeScript, Commander.js)"
2. **Add "Agent Workflow" section** after Architecture:
   ```
   1. Enter worktree with `EnterWorktree` (feature name)
   2. Make code changes
   3. Run `bun cli/src/index.ts build` to deploy
   4. App available at `<name>.localhost:9000`
   ```

## Error Handling

| Condition | Action |
|---|---|
| Not in a git repo | Exit 1, "Not in a git repository" |
| Name fails regex | Exit 1, show invalid name + expected pattern |
| `bun install` fails | Exit 1, "Dependency installation failed" |
| `bun run build` fails | Exit 1, "Frontend build failed" |
| Can't write registry JSON | Exit 1, show OS error |

## Verification

```sh
# From a worktree (.worktrees/test-feature/)
bun cli/src/index.ts build
# → installs deps, builds, writes JSON

cat ~/.singularity/worktrees/test-feature.json
# → { "server": "...", "web": "..." }

# With gateway running:
curl http://test-feature.localhost:9000/gateway/worktrees
# → includes test-feature

open http://test-feature.localhost:9000
# → equin UI loads
```

## Critical Files

- `cli/src/commands/build.ts` — core logic (new)
- `cli/src/index.ts` — Commander entry (new)
- `cli/package.json` — workspace config (new)
- `package.json` — add cli workspace (modify)
- `CLAUDE.md` — agent workflow instructions (modify)
- `gateway/registry.go:19` — name regex reference (read-only)
- `gateway/CLAUDE.md` — worktree JSON format reference (read-only)
