# Per-worktree config_v2

## Context

config_v2 stores user overrides in `~/.singularity/config/` — a single global
directory shared by all worktree backends. This means an agent worktree's
config changes bleed into main and vice versa. The DB-backed config (v1) is
already per-worktree because it lives in the forked Postgres database.

Goal: scope config_v2 by worktree name so each backend reads/writes its own
directory, forked from main at worktree creation time.

## Design

New path layout:

```
~/.singularity/config/<worktree>/<plugin-tree>/<name>.[origin.]jsonc
```

- Main: `~/.singularity/config/singularity/conversations/conversation-category/config.jsonc`
- Agent: `~/.singularity/config/att-1234567890-ab12/conversations/conversation-category/config.jsonc`

### Changes

#### 1. Remove CONFIG_DIR from paths, define in config_v2 server

**File:** `plugins/infra/plugins/paths/core/internal/paths.ts`

Remove the `CONFIG_DIR` export. It only has two consumers, both inside
`config_v2/server/`.

**File:** `plugins/config_v2/server/internal/config-dir.ts` (new)

```ts
import { SINGULARITY_DIR } from "@plugins/infra/plugins/paths/server";

const worktree = process.env.SINGULARITY_WORKTREE;
if (!worktree) {
  throw new Error("SINGULARITY_WORKTREE must be set");
}

export const CONFIG_DIR = join(SINGULARITY_DIR, "config", worktree);
```

This throws at module load if the env var is missing. Only the config_v2 server
plugin imports it, so non-server contexts (checks, codegen, CLI) are unaffected.

Update the two consumers (`registry.ts`, `config-watcher.ts`) to import from
`./config-dir` instead of `@plugins/infra/plugins/paths/server`.

#### 2. Fork config during worktree creation

**File:** `plugins/conversations/server/internal/lifecycle.ts`

After `setupWorktree`, alongside `forkDatabase`:

```ts
void forkConfig(thisAttemptId).catch((err) => {
  console.error(`[conversations] config fork failed for ${thisAttemptId}`, err);
});
```

`forkConfig` implementation — new helper in the config_v2 server barrel or a
small internal module:

**File:** `plugins/config_v2/server/internal/fork.ts`

```ts
import { cp, stat } from "node:fs/promises";
import { join } from "node:path";
import { SINGULARITY_DIR, MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/paths/core";

export async function forkConfig(targetWorktree: string): Promise<void> {
  const sourceDir = join(SINGULARITY_DIR, "config", MAIN_WORKTREE_NAME);
  const targetDir = join(SINGULARITY_DIR, "config", targetWorktree);
  // Skip if source doesn't exist yet (first run, no config written)
  try { await stat(sourceDir); } catch { return; }
  await cp(sourceDir, targetDir, { recursive: true });
}
```

Export from `plugins/config_v2/server/index.ts` so lifecycle.ts can import it.

#### 4. Clean up config on worktree deletion

**File:** `plugins/debug/plugins/worktree-cleanup/server/internal/handle-delete.ts`

Add a `config` step after the `database` step:

```ts
emit({ step: "config" });
const configDir = join(SINGULARITY_DIR, "config", id);
await rm(configDir, { recursive: true, force: true });
```

Same addition in `handle-bulk-delete.ts`.

### Files to modify

| File | Change |
|---|---|
| `plugins/infra/plugins/paths/core/internal/paths.ts` | Remove CONFIG_DIR export |
| `plugins/infra/plugins/paths/server/index.ts` | Remove CONFIG_DIR re-export |
| `plugins/config_v2/server/internal/config-dir.ts` | New file: worktree-scoped CONFIG_DIR with env var validation |
| `plugins/config_v2/server/internal/registry.ts` | Import CONFIG_DIR from `./config-dir` |
| `plugins/config_v2/server/internal/config-watcher.ts` | Import CONFIG_DIR from `./config-dir` |
| `plugins/config_v2/server/internal/fork.ts` | New file: forkConfig helper |
| `plugins/config_v2/server/index.ts` | Export forkConfig |
| `plugins/conversations/server/internal/lifecycle.ts` | Call forkConfig alongside forkDatabase |
| `plugins/debug/plugins/worktree-cleanup/server/internal/handle-delete.ts` | rm config dir on delete |
| `plugins/debug/plugins/worktree-cleanup/server/internal/handle-bulk-delete.ts` | rm config dir on bulk delete |

### What doesn't change

- `registry.ts` — already uses `CONFIG_DIR` for all paths, no change needed.
- `tier-logic.ts` — pure functions operating on ConfigProxy, path-agnostic.
- `config-origins-in-sync` check — operates on git-tracked `config/` dir, not `~/.singularity/config/`.
- `config-watcher.ts` — subscription uses `CONFIG_DIR`, automatically picks up the new scoped path. `mkdir(CONFIG_DIR)` still creates the worktree-scoped dir on first start.

## Verification

1. `./equin build` — server starts, main config lands in `~/.singularity/config/singularity/`
2. Create a conversation — verify `~/.singularity/config/att-<id>/` appears with copied files
3. Change a config_v2 value in main UI — confirm it doesn't appear in the agent worktree's config dir
4. Delete a worktree via worktree-cleanup — confirm `~/.singularity/config/<id>/` is removed
5. `./equin check` — all checks pass
