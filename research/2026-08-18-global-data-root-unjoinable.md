# The data root becomes unjoinable — deleting `SINGULARITY_DIR`

**Date:** 2026-08-18
**Category:** global (`paths`, `launcher`, `cli`, `config_v2`, `apps/mail`, boundaries)

## Context

`defineDataDir` is the sanctioned way to name a directory under `~/.singularity/`,
and every directory now has an owner. But the old door is still open: `paths`
exports `SINGULARITY_DIR`, a plain string of the root, from both its `core` and
`server` barrels (and `cli/bin/paths.ts` re-exports it a third time). While that
export exists, the registry is a convention rather than a constraint — anyone can
mint a new top-level entry with `join(SINGULARITY_DIR, "whatever")`, and the only
thing that notices is `paths:no-undeclared-data-dirs` failing after the fact,
against a directory that already exists on disk.

This is **step 5** of the recorded layout design
([`research/2026-08-17-global-singularity-data-dir-layout.md`](2026-08-17-global-singularity-data-dir-layout.md),
"Enforcement §1"), which the migration change
([`research/2026-08-17-global-singularity-data-dir-migration.md`](2026-08-17-global-singularity-data-dir-migration.md))
explicitly deferred as follow-up. Its stated prerequisite — every directory
declared, the bytes moved — has landed: pass 1 of `migrate-data-layout.ts` has
run (the real root is kind dirs plus compat symlinks), and 29 of 33 declarations
have dropped their `legacyLocation`. The four that remain (`services/postgres`,
`services/sockets`, `services/zero`, `services/node`) are marked **permanent**,
not transitional, so nothing is waiting on them.

Intended outcome: `dataRoot()` is the only way to name the root, joining it is a
check failure, and the root has no frozen string form anywhere.

### What the task brief listed that is already done

The brief was written before the migration landed. Verified against the tree today:

- `PROTOTYPES_DIR`, `ATTACHMENTS_DIR`, `REPORTS_DIR`, `COST_USAGE_DIR` — **gone**
  from `paths/core/internal/paths.ts` (zero references repo-wide).
- `PG_DIR = join(SINGULARITY_DIR, "pg")` in `cli/bin/paths.ts` — **gone**; the file
  now re-exports `PG_LOG_FILE` from the embedded-PG plugin.
- `PROTOTYPES_DIR_DISPLAY` — already reads `~/.singularity/apps/prototypes`, and
  the literal `~/.singularity/prototypes` has **zero** occurrences repo-wide
  (root `CLAUDE.md`, `prototypes/CLAUDE.md` and the agent prompts are all updated).
- `central-routes.json`, `gateway.pid`, the `logs` join, `build.ts`,
  `admission-valve.ts`, `backfill-pushes.ts`, `deploy.ts`, `compose-serve.ts` —
  all migrated; none references `SINGULARITY_DIR` any more.
- `preview-manager.ts`'s `SINGULARITY_DIR: dataRoot` is a *local temp dir* handed
  to a child's env, not a use of the export.

**~37 call sites is now 5**, in 4 consumer files.

## The change

### 1. Delete the constant, keep the derivation

`plugins/infra/plugins/paths/core/internal/paths.ts`

- Delete `export const SINGULARITY_DIR = resolveDataRoot()`. `resolveDataRoot()`
  stays (module-private, already the single derivation); `dataRoot()` in
  `core/internal/data-dir.ts` remains its only public spelling.
- Rewrite the trailing prose block so it stops describing `SINGULARITY_DIR` as
  "still exported for the call sites not yet migrated".

Drop `SINGULARITY_DIR` from the export lists of:

- `plugins/infra/plugins/paths/core/index.ts` (and the explanatory comment above
  the `defineDataDir` block, which is now stale)
- `plugins/infra/plugins/paths/server/index.ts` (same, and the tail of the
  `data-dir` re-export docblock)
- `plugins/framework/plugins/cli/bin/paths.ts` — a pure re-export with no local
  consumer. (`HOME_DIR` there is also unconsumed; drop it in the same pass.)

Removing the export makes every stale import a **tsc error** — rung 2, free.

### 2. `WORKTREES_DIR` becomes lazy

Left as a const it would read `join(resolveDataRoot(), "worktrees")` — the exact
shape being deleted, and against the design's own "lazy resolution" rule (`path`
is a getter, `dataRoot()` is a function, because the release launcher sets the
env *before* importing path-dependent modules).

`paths.ts`: `export const WORKTREES_DIR` → `export function worktreesDir(): string`,
returning `join(resolveDataRoot(), "worktrees")`. `worktreeDataDir(name)` calls it.

Consumers (7 files, mechanical `WORKTREES_DIR` → `worktreesDir()`):

- `plugins/debug/plugins/sentinel/server/internal/worker/sample.ts` (+ its `.test.ts`)
- `plugins/infra/plugins/worktree/server/internal/worktree-op.ts`
- `plugins/framework/plugins/cli/bin/commands/internal/compose-serve.ts` (4 sites)
- `plugins/infra/plugins/launcher/server/internal/boot.ts`
- `plugins/primitives/plugins/log-channels/server/internal/read-channel-json.test.ts`
- `plugins/framework/plugins/cli/bin/paths.ts` (re-export name)

`sample.test.ts` has a comment asserting the gatherers resolve through "the
import-frozen `WORKTREES_DIR`" — update it; the freeze is the thing going away.

`paths/check/index.ts`'s `WORKTREE_ARTIFACT_PATTERNS` includes
`/SINGULARITY_DIR\s*(?:,\s*["'`]|\}?\/)worktrees/` — retarget that pattern at
`dataRoot()` (`join(dataRoot(), "worktrees")` is the new way to re-inline the
base dir), and update `no-inlined-worktree-artifacts.test.ts` alongside it.

### 3. Migrate the 4 remaining consumers

| File | Today | Becomes |
|---|---|---|
| `plugins/infra/plugins/launcher/server/internal/boot.ts:166` | `const PID_FILE = gatewayPidFile(SINGULARITY_DIR)` | `gatewayLocks.file(GATEWAY_PID_FILENAME)` via a lazy `pidFile()` — the declaration lives in this same plugin's `data-dirs/index.ts`; export `GATEWAY_PID_FILENAME` from it. Also un-freezes the const. `gatewayPidFile(root)` stays for the arbitrary-root (preview teardown) caller. |
| `plugins/framework/plugins/cli/bin/commands/serve-app.ts:89` | `gatewayPidFile(SINGULARITY_DIR)` | `gatewayPidFile(dataRoot())` |
| `plugins/framework/plugins/cli/bin/commands/serve-app.ts:93` | `` console.log(`  Root: ${SINGULARITY_DIR}`) `` | `dataRoot()` |
| `plugins/apps/plugins/mail/plugins/threads/e2e/mailbox-tabs-verify.ts:74` | `join(SINGULARITY_DIR, "config", <worktree>, "apps/mail/…")` | `configDir.file(worktree, "apps/mail/threads/mail-threads.jsonc")` from `@plugins/config_v2/data-dirs` |

The mail e2e needs a **boundary grant**: `boundary-config.ts` currently has
`e2e: ["e2e", "core"]`. Add `"data-dirs"` → `e2e: ["e2e", "core", "data-dirs"]`.
An e2e script is a Node process on the host that legitimately reads files under
the data root; without the grant its only option is joining the root by hand,
which is exactly what this change removes. (`data-dirs` is already granted to
`server`, `central`, `shared`.)

### 4. One helper instead of three copies of `relative(dataRoot(), …)`

Three `data-dirs/index.ts` files each carry a near-identical
`relative(dataRoot(), <decl>.path)` function with a near-identical docblock:
`config_v2` (`userConfigRelativeToRoot`), `infra/launcher`
(`gatewayPidFileRelativeToRoot`), `infra/asset-mirror` (`assetMirrorRelativeToRoot`).

Hoist into `paths/core/internal/data-dir.ts`, exported from both barrels:

```ts
/** Where a declared directory (or a file in it) sits RELATIVE to the data root. */
export function relativeToDataRoot(dir: DataDir, ...segments: string[]): string;
```

Typed on `DataDir`, so it cannot be used to relativise an arbitrary path. The
three callers keep their names as one-line wrappers (each has real
caller-specific prose worth keeping) but stop calling `dataRoot()` themselves —
which leaves `dataRoot()` with essentially one caller shape left: hand the root
to a child process, or print it.

### 5. `paths:data-root-not-joined` — the new check

New `Check` in `plugins/infra/plugins/paths/check/index.ts` (third alongside
`no-hardcoded-paths` and `no-inlined-worktree-artifacts`), same shape: `grepCode`
from `@plugins/framework/plugins/tooling/plugins/checks/core`, a `PATTERNS` array,
an `ALLOWED_PATHS` list. Modelled on
`checks/plugins/host-pools-declared/check/index.ts`, the established way this
codebase makes a primitive the only door.

**Banned form A — joining the root.** `join(dataRoot()`, `resolve(dataRoot()`,
and `` `${dataRoot()}/ ``. Allowed: `plugins/infra/plugins/paths/` (owner).

**Banned form B — re-deriving the root from the environment.** A read of
`process.env.SINGULARITY_DIR` *not* immediately followed by `=` (so `??=`, `=`,
and `SINGULARITY_DIR:` env-object keys — the sanctioned handoff to a child — are
never flagged).

Allowlist for B, each with the reason inline in the array (the existing
`ALLOWED_PATHS` convention — an entry leaves the list the moment its literal does):

- `plugins/infra/plugins/paths/core/internal/paths.ts` — `resolveDataRoot()`, the owner.
- `plugins/infra/plugins/launcher/bin/launch.ts` and `bin/teardown.ts` — release
  entry points that *set* the root and read back what they just wrote, before any
  path-dependent module is imported.
- `plugins/framework/plugins/cli/bin/commands/serve-app.ts` — the presence guard
  (`if (!process.env.SINGULARITY_DIR)`); `dataRoot()` cannot express "explicitly
  set", it would silently answer `~/.singularity`.
- `*.test.ts` / `*.test.tsx` — categorical, via a suffix check rather than named
  entries. Precedent: `sink-safety`'s rule exemptions. Four tests point the root
  at a temp dir to stay hermetic; that is the correct thing for a test to do.

Register in `plugins/infra/plugins/paths/check/index.ts`'s default export and add
unit coverage beside the existing `no-hardcoded-paths.test.ts` /
`no-inlined-worktree-artifacts.test.ts` (same fixture shape: string-split the
patterns so the test file does not match itself).

Update `paths/CLAUDE.md` — the "root itself is unjoinable" section currently
states the rule as prose; it now names the check that enforces it. Also fix
`no-hardcoded-paths`'s `hint`, which still tells offenders to import
`SINGULARITY_DIR`.

### 6. Optional — `REPO_CONFIG_DIR` too (strike this if you want the diff tight)

`REPO_CONFIG_DIR` is the *other* env-frozen constant in `paths.ts`
(`process.env.SINGULARITY_REPO_CONFIG_DIR ?? join(REPO_ROOT, "config")`), and
`launch.ts` sets that var at line 74 for the same reason. Two consumers only
(`config_v2/server/internal/registry.ts`, `scope-fork.ts`), so making it a
function is ~5 lines.

It matters because of what it unblocks: `launch.ts`'s header carries a "CRITICAL
ordering — do NOT statically import anything path-dependent" discipline, enforced
only by a comment. That discipline is load-bearing for as long as *any* constant
in `paths.ts` freezes an env read. Doing `WORKTREES_DIR` alone leaves it standing;
doing both retires it, and `launch.ts`'s docblock can say so.

## Verification

1. `./equin check paths:data-root-not-joined` — green. Then confirm it goes
   **red**: add `join(dataRoot(), "x")` to a scratch file and re-run, then add a
   bare `const r = process.env.SINGULARITY_DIR` and re-run. Delete the scratch file.
2. `./equin check` (background) — the full suite, especially `type-check`
   (which is what proves no stale `SINGULARITY_DIR` import survives),
   `plugin-boundaries` (the new `e2e → data-dirs` grant), and the two existing
   `paths:` checks.
3. `./equin test plugins/infra/plugins/paths` — the check's own unit tests
   plus `data-dir.test.ts` / `legacy-layout.test.ts`.
4. `./equin build` (background, then end the turn) — proves the launcher,
   gateway spawn and per-worktree artifact paths still resolve with
   `worktreesDir()` lazy. Confirm via the deploy receipt at
   `~/.singularity/worktrees/<wt>/build-status.json` (`status: ok`).
5. `./equin check paths:no-undeclared-data-dirs` — unchanged green; the real
   root must be untouched by this change (it moves no bytes).
6. Manual, optional: the mail e2e is the only migrated consumer with runtime
   behaviour worth exercising —
   `bun plugins/apps/plugins/mail/plugins/threads/e2e/mailbox-tabs-verify.ts`
   should still find the config override file under `state/config/<worktree>/`.

## Explicit non-goals

- **Running `--drop-legacy`.** The compat symlinks and the `LEGACY_LAYOUT` table
  are a filesystem concern on a separate clock (every worktree must have rebuilt
  first). Nothing in this change depends on them, and nothing here should delete
  them.
- **The four permanent `legacyLocation` entries.** `services/{postgres,sockets,zero,node}`
  stay where the running processes have them.
- **`gateway/main.go` and `tauri/src-tauri/src/lib.rs`.** Both read the root from
  the environment, which is the sanctioned handoff and is out of the TS check's
  reach.
