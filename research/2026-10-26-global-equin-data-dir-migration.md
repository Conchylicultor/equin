# Step 7: `~/.equin` data dir and the `dev.equin.gateway` label

Track: the rename-to-equin track (wiki `block-dc049371-1f5f-413d-af7b-6e12b531d579`), step 7 of
`research/2026-10-25-global-equin-internal-identifiers.md`.

## Context

Every install keeps its state under `~/.singularity/`, and the gateway runs as the launchd/systemd
job `dev.singularity.gateway`, which shows in Login Items. The decision says new installs get
`~/.equin`. Existing installs move with a command the user runs while nothing else is running; the
user noted on the track page that it must be safe. After this step, the `~/.singularity` allowance in
`product-name:legacy-id` is removed.

What exploration found:

- **Only two places compute the root**: TS `resolveDataRoot` (`plugins/infra/plugins/paths/core/internal/paths.ts:222`)
  and Go `dataRoot` (`gateway/main.go:58`). Everything else in TS goes through `dataRoot()` /
  `defineDataDir` / `worktreesDir()`. Shell scripts hardcode it: `install.sh:182`,
  `sidequests/clean-install/{run,steps,steps-install}.sh`, and `sidequests/monitors/fd/fd-monitor.sh`.
  Rust never computes it. About 150 other mentions are prose (CLAUDE.md files, comments, test fixtures), and
  four are user-visible strings in `paths/plugins/display`.
- **Absolute old-root paths are stored and never rewritten**: `state/db-config/database.json`
  (`ensureDatabaseConfig` writes it only when it is absent), all 823 `attachments.disk_path` rows,
  `release_runs.artifact_path`, scratch `worktree_path` rows, python venv `pyvenv.cfg` in the deps cache,
  and each running agent's argv. **So the `~/.singularity → ~/.equin` symlink is permanent.**
  It is not a temporary shim.
- **`./equin stop` does not stop Postgres, PgBouncer or SDK agent processes.** They are
  detached by design. The migration has to stop them itself.
- **`./equin start` will not remove the old job**, and it would register a *second* gateway under a new
  label on an unmigrated machine, so two gateways would fight over port 9000. The label must follow
  the installed state, not a constant.
- Everything is on one APFS volume, so `rename(2)` of the 36 GB root is atomic and O(1). 26 of the
  root's entries are relative symlinks, which survive the move.
- Precedent: `plugins/infra/plugins/paths/scripts/migrate-data-layout.ts` uses a pure planner
  (`planMigration`, unit-tested) plus a dry run by default and `--apply`, and refuses while a gateway is alive.

## Design

### 1. Installed state decides, not the code version

The root and the label are each derived from what is on disk, so new code on an unmigrated machine
keeps using the old names until the user migrates:

```
dataRootLayout():
  readEnv("DIR") set                                  → { kind: "custom",  root: $DIR }
  ~/.singularity exists, and is not ~/.equin (realpath)
      and ~/.equin exists too                         → throw DataRootSplitError (both, loudly)
      otherwise                                       → { kind: "legacy",  root: ~/.singularity }
  otherwise                                           → { kind: "current", root: ~/.equin }
```

- Fresh install: `current`. Unmigrated: `legacy` (and a stray `~/.equin` cannot split it, because that
  case fails loudly). Migrated (`~/.singularity` is a symlink to `~/.equin`): `current`. A
  `~/.singularity` the user symlinked to an external disk resolves elsewhere, so it stays `legacy`
  and is not mistaken for a fresh install.
- `resolveDataRoot()` becomes `dataRootLayout().root`, and `dataRootLayout` is exported from `paths/core`.
- Go `dataRoot()` mirrors the same rule. A Go unit test and the TS `paths.test.ts` share one table of
  cases (both use temp HOMEs).
- Shell (`install.sh`, clean-install scripts, `fd-monitor.sh`) uses one tiny function with the same rule
  (`[ -e ~/.singularity ] && [ ~/.singularity -ef ~/.equin ]`…).
- `LEGACY_IDS` gains `dataDirName: ".singularity"`, whose `mirrors` are those Go and shell files, so
  `product-name:legacy-ids-in-sync` holds them to it. The new name is `"." + PRODUCT_NAME`. Then **delete
  the data-dir `ALLOWED` entry** in `product-name/check/legacy-id.ts`.

**Gateway label.** `GATEWAY_SERVICE` (`launcher/server/internal/gateway-service.ts`) becomes
`gatewayService()`. It is `LEGACY_IDS.launchdLabel` while that job's plist/unit file is installed
(`~/Library/LaunchAgents/<old>.plist` / the systemd unit path the login-services manager already
computes), and `dev.${PRODUCT_NAME}.gateway` otherwise. `codesignIdentifier` stays
`dev.singularity.gateway`, because TCC grants are keyed on it. It is already a separate key. Callers
updated: `start/cli/{index,run}.ts`, `stop/cli/run.ts`, `gateway-drift/machine/internal/check.ts`.

**Menu-bar helper, no Rust mirror.** `plugins/menu-bar/rust/src/gateway.rs` hardcodes the label for
`launchctl kickstart`. Instead, `trayEnv()` in `plugins/menu-bar/login-services/index.ts` passes
`EQUIN_GATEWAY_LABEL` (declared in `infra/launcher/env-names`), and Rust reads it. A label change
changes the helper's job, so `start`'s reconcile reinstalls it. Drop `gateway.rs` from the
`launchdLabel` mirrors. `steps-install.sh` keeps its mirror, but it is a fresh VM, so it spells the new
label.

**Siblings the notes tie to step 7** (new installs only, nothing moved):
- `backupsDirName`: `~/.backups/singularity` while it exists, otherwise `~/.backups/equin`. Backups are not
  moved, so no risk to existing archives.
- `defaultCheckoutDir`: `install.sh` clones to `~/equin`. An existing checkout is never moved, because git
  worktrees store absolute gitdirs.

### 2. `./equin data-dir migrate` (user-run)

It is a new child plugin, `plugins/infra/plugins/paths/plugins/root-migration/`, with `cli/` (a `data-dir`
group with a `migrate` leaf, the same shape as `exempt list`) and `core/` (a pure planner). It is a child
rather than `paths/cli` because `run.ts` imports `launcher/server`, which imports `paths`.

**Facts → plan (pure, unit-tested `planRootMigration(facts)`)**, the same split as `planMigration`.
Facts: the layout, which label files are installed, `~/.backups/` state, and the list of live work. The
plan is idempotent: run on a migrated root with the old label still installed, it only relabels. Run
when everything is done, it prints "nothing to do".

**Refusals, before anything is touched** (each prints what blocks it and how to clear it):
1. Run by an agent (a conversation id in the env via `readEnv`). Only the user runs this, from a terminal.
2. `custom` layout (a `$DIR` override, such as a release bundle or a VM). There is nothing to move.
3. `DataRootSplitError`, or `~/.singularity` symlinked somewhere other than `~/.equin`. It prints both
   paths, and no automatic answer is attempted.
4. Live work: `listActiveWorktreeOps()` (op flocks: build/push/check/test/e2e), and live SDK agent
   processes (pid files under `locks/sdk-agents/*/*.pid` + `pidAlive`, the same logic as
   `agent-processes.ts`, exposed for this). The cwd is inside the data root (a scratch workspace).

**Without `--apply`**, it prints the plan and changes nothing. **With `--apply`**:
1. `detachable: true`, so the run survives its terminal closing midway (the orphan guard).
2. Stop, awaiting each exit: login services (menu-bar), then the gateway (unload the installed label +
   `awaitProcessGone`, the same as `stop/cli/run.ts`), then PgBouncer (SIGINT, safe shutdown) and Postgres
   (`pg_ctl stop -m fast`, never SIGQUIT), by their pid files (`pgbouncerPidFileUnder`,
   `pgPostmasterPidFile`). Refusal 4 is re-checked after the stop, because a gateway could have launched
   an agent between check and stop.
3. `rename(~/.singularity, ~/.equin)`, then `symlink(".equin", ~/.singularity)` (relative). If the
   symlink fails, the rename is undone and the command fails loudly.
4. Rewrite the old-root prefix in `state/db-config/database.json` (a JSON parse, a prefix replace on
   string values under the root, and an atomic write). The other stored paths stay as they are; the
   symlink resolves them.
5. Claude Code keys transcripts by the physical cwd. For every `~/.claude/projects/<encoded old root …>`
   dir, symlink `<encoded new root …>` → it, so resuming an old scratch conversation finds its
   transcript. *Verify first (rehearsal); drop this step if Claude Code resolves it already.*
6. Relabel: `bootout` + remove the old plist/unit, then run the same code path as `./equin start`
   (gateway + login services; it now resolves `~/.equin` and `dev.equin.gateway`), and await
   `awaitGatewayReady`.
7. Print a summary, plus the known one-time cost: bundle-less binaries in the deps cache are
   TCC-keyed by path, so they may re-prompt once.

### 3. Sweep and checks

- Prose and fixtures: `~/.singularity` → `~/.equin` across CLAUDE.md files, docs, comments, skills,
  `config/tasks/automations/upstream-merge.origin.jsonc`, and the four `display.ts` strings. Generated
  docs are regenerated by `./equin build`, not hand-edited. `research/` is left alone (out of scope of
  the check). One sentence in `docs/setup.md` and the `infra/paths` CLAUDE.md describes the layout rule
  and `data-dir migrate`.
- `paths:no-hardcoded-paths`: the banned literal also covers `~/.equin`.
- Docs that spell `LEGACY_IDS.launchdLabel` say `gatewayService().label`.

### 4. Follow-ups (sidequests, not this step)

- Absolute data-root paths stored in DB rows (`attachments.disk_path`, `release_runs.artifact_path`,
  `*.worktree_path`) and in `database.json` pin the `~/.singularity` symlink forever. Storing them
  relative to the root would let it go.
- `teardownSelfContainedApp` stops Postgres with SIGQUIT (immediate, so crash recovery runs on the next boot).

## Critical files

- `plugins/infra/plugins/paths/core/internal/paths.ts`: `dataRootLayout`, `resolveDataRoot`, backups dir
- `gateway/main.go` (`dataRoot`), with a new `gateway/dataroot_test.go`
- `plugins/framework/plugins/product-name/core/internal/legacy-ids.ts`, `…/check/legacy-id.ts`
- `plugins/infra/plugins/launcher/server/internal/gateway-service.ts`, `start/cli/run.ts`, `stop/cli/run.ts`,
  `gateway-drift/machine/internal/check.ts`
- `plugins/menu-bar/login-services/index.ts`, `plugins/menu-bar/rust/src/gateway.rs`, `infra/launcher/plugins/env-names`
- New: `plugins/infra/plugins/paths/plugins/root-migration/{cli,core}`
- `install.sh`, `sidequests/clean-install/*.sh`, `sidequests/monitors/fd/fd-monitor.sh`

## Verification

- Unit tests: the `dataRootLayout` table (TS + Go, the same cases), `planRootMigration` (fresh, legacy,
  migrated with the old label, done, split, and foreign symlink), and the label choice.
- `./equin build` and `./equin check`: `product-name:legacy-id` is green with the allowance removed, along
  with `legacy-ids-in-sync`, `launcher:env-names`, `paths:*` and `type-check`.
- On this machine, before migrating: the build of this worktree still resolves `~/.singularity` and the
  gateway drift row still reads current (no second job). `./equin data-dir migrate` (dry run) prints the plan.
- Rehearsal in a Tart VM (`sidequests/clean-install`): install on the old layout, check out this branch,
  `data-dir migrate --apply` → `~/.equin` real dir and `~/.singularity` symlink,
  `launchctl print gui/<uid>/dev.equin.gateway` is up and the old label is gone,
  `http://equin.localhost:9000` serves, an attachment still opens, and resuming an old scratch conversation
  works (decides step 5). A fresh install → `~/.equin` with no `~/.singularity`.
- The migration on the user's own machine is **run by the user**, not by the agent.

## Wrap-up

Update the track page (status, step 7 checked with sub-items). File the next main task, "Drop the old
`SINGULARITY_*` variable names", gated on every install having restarted. File the two sidequests above.
