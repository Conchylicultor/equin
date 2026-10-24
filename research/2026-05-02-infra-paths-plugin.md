# Infra Paths Plugin

## Context

Filesystem paths and system binary locations are scattered across 15+ server files as inline `homedir()` calls, bare `process.env.HOME` template strings, and hardcoded absolute paths like `/usr/bin/git`. This makes the codebase brittle on non-standard setups and creates no obvious canonical place to look for where data lives. A new `plugins/infra/plugins/paths/` sub-plugin becomes the single source of truth for all of this.

A separate agent will add `./equin check --no-hardcoded-paths` enforcement; this plan covers only the plugin and migration.

---

## New plugin: `plugins/infra/plugins/paths/`

### File structure

```
plugins/infra/plugins/paths/
├── package.json          # name: "@singularity/plugin-infra-paths"
└── server/
    ├── index.ts          # barrel + minimal ServerPluginDefinition
    └── internal/
        ├── paths.ts      # filesystem path constants
        └── bins.ts       # binary resolution
```

No `web/` or `shared/` — filesystem paths are server-only.

### `server/internal/paths.ts`

All paths are module-level constants (eagerly evaluated at startup, consistent with the existing secrets `paths.ts` pattern). `SINGULARITY_DIR` is **exported** so `store.ts` can import it instead of re-calling `homedir()`.

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export const SINGULARITY_DIR      = join(homedir(), ".singularity");
export const SECRETS_DIR          = join(SINGULARITY_DIR, "secrets");
export const STORE_PATH           = join(SINGULARITY_DIR, "secrets.json.enc");
export const KEY_PATH             = join(SECRETS_DIR, ".key");
export const LEGACY_AUTH_DIR      = join(SINGULARITY_DIR, "auth");
export const LEGACY_AUTH_BLOB     = join(LEGACY_AUTH_DIR, "tokens.json.enc");
export const LEGACY_AUTH_KEY      = join(LEGACY_AUTH_DIR, ".key");
export const ATTACHMENTS_DIR      = join(SINGULARITY_DIR, "attachments");
export const CRASHES_DIR          = join(SINGULARITY_DIR, "crashes");
export const CLAUDE_PROJECTS_DIR  = join(homedir(), ".claude", "projects");
export const CLAUDE_SESSIONS_DIR  = join(homedir(), ".claude", "sessions");
```

### `server/internal/bins.ts`

Moves and generalises the `resolveBin` helper that currently lives only in `tmux-runtime.ts`. Merges the two divergent CLAUDE resolution implementations (env-override from `run-claude-print.ts` + fallback list from `tmux-runtime.ts`).

```ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";

function resolveBin(name: string, extraCandidates: string[]): string {
  const fromPath = Bun.which(name);
  if (fromPath) return fromPath;
  for (const p of extraCandidates) {
    if (existsSync(p)) return p;
  }
  return name;
}

// Simple fallback for binaries reliably at standard system paths
export const GIT   = Bun.which("git")   ?? "/usr/bin/git";
export const PGREP = Bun.which("pgrep") ?? "/usr/bin/pgrep";

// Richer resolution for binaries with varied install locations
export const CLAUDE =
  process.env.SINGULARITY_CLAUDE_BIN ??
  resolveBin("claude", [
    `${homedir()}/.local/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]);

export const TMUX = resolveBin("tmux", [
  `${homedir()}/.local/share/mise/shims/tmux`,
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/usr/bin/tmux",
]);
```

### `server/index.ts`

Minimal `ServerPluginDefinition` (no routes, no lifecycle — consistent with the infra umbrella pattern). Re-exports everything from both internal files.

```ts
export * from "./internal/paths";
export * from "./internal/bins";

export default {
  id: "paths",
  name: "Paths",
  description: "Single source of truth for filesystem paths and binary resolution.",
} satisfies ServerPluginDefinition;
```

### `package.json`

```json
{ "name": "@singularity/plugin-infra-paths", "private": true }
```

---

## Migration

Consumer import path: `@plugins/infra/plugins/paths/server` (consistent with how other infra sub-plugins import each other, e.g. events → jobs).

### 1. Secrets plugin — delete local `paths.ts`, update importers

`plugins/infra/plugins/secrets/central/internal/paths.ts` — **delete** (all its exports move verbatim to the paths plugin).

Files that currently import from `./paths` inside the secrets plugin:
- `plugins/infra/plugins/secrets/central/internal/boot.ts`
- `plugins/infra/plugins/secrets/central/internal/migrate-auth-tokens.ts`
- `plugins/infra/plugins/secrets/central/internal/key-store.ts`

Each: change `from "./paths"` → `from "@plugins/infra/plugins/paths/server"`.

`plugins/infra/plugins/secrets/central/internal/store.ts` — remove the redundant inline `path.join(homedir(), ".singularity")` block (lines 43–46); import `SINGULARITY_DIR` from the paths plugin instead.

### 2. Attachments plugin

`plugins/infra/plugins/attachments/server/internal/paths.ts` — replace `join(homedir(), ".singularity", "attachments")` call inside `attachmentsRoot()` with the imported `ATTACHMENTS_DIR` constant. Keep `ensureAttachmentsRoot()` and `diskPathFor()` as local helpers (they stay in this file).

### 3. Crashes plugin

`plugins/crashes/server/internal/buffer.ts:11` — replace `join(homedir(), ".singularity", "crashes")` with imported `CRASHES_DIR`.

### 4. runtime-tmux

`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`:
- Remove local `resolveBin` function and the `home` variable
- Remove `TMUX` and `CLAUDE` local const declarations
- Import `TMUX`, `CLAUDE` from paths plugin

`plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts`:
- Replace `SESSIONS_DIR` declaration with imported `CLAUDE_SESSIONS_DIR`
- Replace `/usr/bin/pgrep` literal with imported `PGREP`

### 5. claude-cli

`plugins/infra/plugins/claude-cli/server/internal/run-claude-print.ts`:
- Replace the `CLAUDE_BIN` IIFE (including inline `require()` workarounds) with imported `CLAUDE`

### 6. conversations

`plugins/conversations/server/internal/claude-transcript.ts:3` — replace `PROJECTS_DIR` declaration with imported `CLAUDE_PROJECTS_DIR`.

### 7. All GIT consumers (12 files)

Replace `const GIT = "/usr/bin/git";` with an import from the paths plugin in each file:

| File |
|------|
| `server/src/worktree.ts` |
| `server/backfill-pushes.ts` |
| `plugins/tasks/server/internal/push-watcher.ts` |
| `plugins/tasks/server/internal/handle-repo-info.ts` |
| `plugins/debug/plugins/worktree-cleanup/server/internal/handle-list.ts` |
| `plugins/code-explorer/server/internal/tree-handler.ts` |
| `plugins/code-explorer/server/internal/resolve-ref.ts` |
| `plugins/code-explorer/server/internal/get-file-diff.ts` |
| `plugins/code-explorer/server/internal/get-file-content.ts` |
| `plugins/code-explorer/server/internal/get-push-files.ts` |
| `plugins/stats/plugins/commits/server/internal/commit-timestamps.ts` |
| `plugins/conversations/plugins/conversation-progress/server/internal/heuristic-job.ts` |
| `plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/internal/git.ts` |
| `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/get-edited-files.ts` |

### 8. db-backup (local fix, not centralised)

`plugins/debug/plugins/db-backup/server/internal/handle-backup.ts:14` and `list-backups.ts:94` — replace `process.env.HOME` with `homedir()` from `node:os`. The `~/.backups/singularity` path stays local (it's plugin-specific and shared nowhere).

### 9. Register in `server/src/plugins.ts`

Add `pathsPlugin` import alongside the other infra sub-plugin imports and insert it at the start of the infra block (before attachments, jobs, etc., since those will import from it).

---

## Out of scope

- **CLI** (`cli/src/commands/build.ts`, `cli/src/commands/start.ts`) — separate runtime with its own tsconfig; cannot import from `@plugins/*`. Local `SINGULARITY_DIR` definitions stay as-is.
- **Go gateway** — user excluded.
- **`./equin check --no-hardcoded-paths`** — separate agent.
- **`plugins/code-explorer/server/internal/image-handler.ts` `~` expansion** (lines 37–38) — legitimate user-path expansion, not a hardcode.
- **`plugins/terminal/server/internal/pty-manager.ts` `process.env.HOME || "/"`** — PTY cwd fallback, not a path construction concern.

---

## Verification

```bash
./equin build   # must compile and restart cleanly
```

After build:
1. Open any conversation with a tmux runtime — TMUX/CLAUDE resolved correctly (session starts)
2. Open the code-explorer or commits-graph — GIT calls succeed
3. Check `~/.singularity/attachments/`, `~/.singularity/crashes/` still writable by doing an upload and triggering a crash log
4. Run `rg 'const GIT\s*=' --type ts plugins/ server/` — should return zero results
5. Run `rg 'homedir\(\)' --type ts plugins/ server/ --glob '!**/paths/server/**'` — should return only the two legitimate exceptions noted in "out of scope"
