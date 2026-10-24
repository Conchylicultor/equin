# Migrating `~/.singularity/` onto the declared layout

Implementation plan. Design: [`2026-08-17-global-singularity-data-dir-layout.md`](./2026-08-17-global-singularity-data-dir-layout.md).

## Context

The registry landed (`defineDataDir`, `paths:no-undeclared-data-dirs`, 18 owners
declaring ~30 directories) but **the layout it describes does not exist**. Every
declaration carries `legacyLocation: { path: "<old name>", reason: "not yet
moved" }`, pinning it byte-for-byte to where its data sits today. The root still
has 63 top-level entries, `LEGACY_TOP_LEVEL` still carries 40, and the check is
green only because that list grandfathers them.

So the registry currently proves ownership and nothing else: `cache/` and
`locks/` are not reclaimable wholesale because they do not exist, `~1 GB` of
orphans is indistinguishable from live state, and nine loose FILES cannot be
declared at all — `DataDir` names a directory and `ensure()` now throws on an
existing non-directory.

**Intended outcome:** the root becomes seven kind directories plus the four
grandfathered live services; every temporary `legacyLocation` is deleted; the
orphans sit in `deprecated/`; `LEGACY_TOP_LEVEL` is gone as a hand-written list.

### Decisions taken (this conversation)

| Question | Decision |
|---|---|
| Orphans | Quarantine into `deprecated/`, not deleted. |
| `backups/` (796 MB hand-made pg dump) | Also into `deprecated/`. It has **no code owner at all** — `BACKUPS_DIR` is `~/.backups/singularity`, outside the data root. |
| What triggers the move | A **hand-run CLI command only**. No launcher hook. |
| Worktrees still on old code | Must **keep working** through the move. The move leaves a symlink at each legacy path; a later pass deletes them. |
| Scope | Through the move, one push. `SINGULARITY_DIR` stays exported; the design's step 5 (`paths:data-root-not-joined`) is follow-up. |

## The one structural idea: a single legacy table

`legacyLocation` is what tells the migration where a directory sits today — and
this change **deletes every one of those blocks**. So the migration cannot read
its plan from the registry it is about to correct.

New file `plugins/infra/plugins/paths/core/internal/legacy-layout.ts`, exported
from `paths/core`. One table, two consumers:

```ts
export type LegacyMove =
  /** Rename the directory to `<kind>/<name>`, then SYMLINK the old name at it. */
  | { from: string; move: "dir"; to: DataDirRef }
  /** Move the file — AND its rotation siblings `<from>.1`, `<from>.2`, … —
   *  INTO `<kind>/<name>/`, then symlink each old name at its new file. A
   *  family moves together or history silently truncates: every reader passes
   *  `includeRotated: true`. */
  | { from: string; move: "file"; to: DataDirRef }
  /** Exists only mid-operation, so a symlink is actively wrong (`unlink` would
   *  remove the shim, not the target). Nothing to move; old and new code write
   *  different paths for one release cycle. `reason` states the degradation. */
  | { from: string; move: "transient"; to: DataDirRef; reason: string }
  /** No live owner. Move into `deprecated/<from>`. No shim. */
  | { from: string; move: "quarantine"; reason: string };

export const LEGACY_LAYOUT: readonly LegacyMove[] = [ … ];
```

- `paths/check/index.ts` derives its grandfathering from `LEGACY_LAYOUT`'s `from`
  names (plus computed rotation siblings). The check's to-do list and the
  migration's plan become the same fact, so they cannot drift.
- The CLI command executes it.

This replaces the hand-written 40-entry `Set` — and it makes the grandfathering
**verified rather than blanket**: a legacy name is accepted only if it is a
symlink resolving to its declared target (or, for `transient`/`quarantine` rows,
absent). A legacy name sitting there as a real directory after the move is a
failure, not a tolerated leftover. When the shims are dropped the rule matches
nothing and is deleted with the table.

## Making it smooth: rename, then shim

A bare `rename` breaks every worktree still running pre-move code, because its
backend keeps naming the old path. The fix is one extra syscall per entry:

```
rename(~/.singularity/config, ~/.singularity/state/config)
symlink(~/.singularity/state/config, ~/.singularity/config)
```

There is exactly **one copy of the bytes**, at the new path. Old code reaches it
through the shim, new code reaches it directly. Everything that happens *inside*
a shimmed directory — create, rename, unlink, a file-sink rotation — operates on
real entries in the real directory, so fidelity is exact. `mkdir -p` on a
symlink-to-directory succeeds, which is what the surviving
`mkdirSync(SINGULARITY_DIR)` calls need.

Three cases the shim does not cover, each stated rather than papered over:

- **`logs/` needs no shim, and cannot have one.** `logs` is a kind name, so the
  root entry must be the kind directory — it cannot also be a symlink to
  `logs/gateway`. It doesn't need to be: the gateway is the only writer of those
  1505 files, it is restarted as part of the move, and it is handed `-log-dir`
  explicitly. No old writer survives the move.
- **Rotation across the shim.** A rotating log's live file is symlinked, and
  `rename` on a symlink moves the *link*. So whichever side rotates first leaves
  one stray entry at the root (a real file if old code rotated, a dangling link
  if new code did). The four rotating sinks are 2 MB-capped observability logs;
  worst case is one rotation window visible in one view and not the other. The
  drop-legacy pass sweeps whatever is left.
- **Transient files** (`duress.latch`, `push-holder.json`). Both are created and
  `unlink`ed at runtime, so a shim would be removed by the first clear. They are
  simply not moved; old and new code write different paths for one cycle. Both
  degradations are safe and self-healing: a stale worktree won't observe a duress
  episode (so it writes *more* observability, never less), and its op-status
  shows a push running — the flock probe still reaches `locks/push/slot-0.lock`
  through the `push-slots` shim — but not who holds it.

**No `.layout-version` marker file** (a deliberate deviation from the design
doc). A marker would itself be an undeclared loose file at the root, and the
command is already idempotent by inspection: `from` absent + `to` present ⇒ done.

## Target mapping

Every row below is a `LEGACY_LAYOUT` entry AND a `legacyLocation` deletion.

**`apps/`** — `attachments` (new decl, owner `infra/attachments`), `prototypes`,
`wallpaper`, `sonata`.

**`state/`** — `config`, `cost-usage`, `releases`, `reports` (all declared
already); plus new: `state/secrets` (owner `infra/secrets`, holds
`secrets.json.enc` and `.key`), `state/auth` (`auth/`), `state/gateway` (owner
`infra/launcher`, holds `central-routes.json`), `state/db-config` (owner
`database`, holds `database.json`).

**`cache/`** — `check-cache`→`check`, `closure-cache`→`closure`, `tsbuildinfo`,
`web-artifacts`, `asset-mirror`, `layout-lab-cache`→`layout-lab`,
`prototype-thumbnails`→`prototypes-thumbnails`, `native`→`signal-origin-native`.

**`locks/`** — the seven live `<pool>-slots` dirs → `locks/<pool>`; plus new
`locks/gateway` (holds `gateway.pid`) and `locks/duress` (holds `duress.latch`).
`push-holder.json` moves **into `locks/push`**, host-admission's existing
declaration — imported by `infra/worktree` rather than re-declared, the same way
`database/pgbouncer` imports `pgClusterDir`. It is the identity companion to
`slot-0.lock`; they belong in one directory with one owner.

**`logs/`** — `logs`→`logs/gateway` (1505 files), `op-log.jsonl`+3 rotations →
`logs/op-log`, `signal-origin.jsonl`+2 → `logs/signal-origin`,
`build-progress.jsonl`+2 → `logs/build-progress`, `check-progress.jsonl`+2 →
`logs/check-progress`; plus new `logs/monitors` (owner `debug`) for the
`sidequests/monitors/` launchd scripts, which run outside the build and can
declare nothing themselves.

**`services/`** — `postgres`, `zero`, `node` keep their **permanent**
`legacyLocation`. `sockets` gains one (new decl, owner `infra/launcher`): it is
live IPC state the running gateway holds open, same category as the other three.
`services/` therefore never appears on disk, which is correct.

**`deprecated/`** — quarantined, with `reason`:

- dirs: `eslint-closure-cache`, `wedge-repro`, `wedge-captures-manual`,
  `scripts`, `crashes` (pre-rename `reports/`; the backup source's `crashes` arm
  was already dropped, see `assemble-singularity-platform.ts:66-71`),
  `forensics` (empty, zero references), `backups`, and the three stale semaphore
  dirs `build-slots`, `type-check-worker-{background,interactive}-slots`.
- files: `op-wedge-captures.log{,.1,.2,.3}`, `push-contention.jsonl`,
  `build-log.jsonl`, `push-8x3g-detached.log`, `push-8x3g-run.sh`,
  `check-progress.jsonl.preformat.bak`, `push.lock` — confirmed orphan; the live
  mutex is `pushPool.slots.file("slot-0.lock")` and the only other `push.lock`
  in the repo is a temp path in `worktree-op.test.ts:161`.

Root immediately after the move: the seven kind dirs, the four services, and
~35 compatibility symlinks. After the drop-legacy pass: `apps cache deprecated
locks logs state worktrees` + `postgres sockets zero node`.

## A one-off script, in two passes

**Not a CLI command.** This is a historical repair that becomes a no-op the
moment it has run — it is not a capability the tool should carry forever. The
repo already has the exact shape for this:
`plugins/framework/plugins/server-core/scripts/backfill-pushes.ts`, a one-time
backfill run as `bun <path> [--write]`, dry-run by default, importing `@plugins/*`
freely, registered nowhere.

`plugins/infra/plugins/paths/scripts/migrate-data-layout.ts` — same shape, under
the plugin that owns the registry. `tsconfig.tools.json:17` already covers
`plugins/**/scripts/*.ts`, so it type-checks with no wiring.

```bash
bun plugins/infra/plugins/paths/scripts/migrate-data-layout.ts                # dry run
bun plugins/infra/plugins/paths/scripts/migrate-data-layout.ts --apply        # pass 1
bun plugins/infra/plugins/paths/scripts/migrate-data-layout.ts --drop-legacy  # pass 2
```

- **No flag = dry run.** Prints every planned rename, shim and quarantine,
  touches nothing, exits 0.
- **`--apply`** — pass 1: move the bytes and leave the shims. **Refuses while a
  gateway pid is alive** (`readPid` / `isRunning` from
  `@plugins/infra/plugins/launcher/server`); the refusal names the exact `kill`
  line. No `--force`.
- **`--drop-legacy`** — pass 2, run once every worktree has rebuilt on the new
  code. Deletes the shims and sweeps the strays the shim scheme can leave (a
  rotated log at the root, a dangling `.1` link, the two stale transient files).

  It runs a **precondition first**, and when that is violated the precondition
  IS the whole plan — no row gets a verdict about a state the root is not in.
  Every non-transient, non-quarantine legacy name must already be a symlink to
  its declared target, or absent. A real file or directory there means pass 1
  has not run, so the entry is the ORIGINAL and removing it would delete the
  only copy.

  > **Added 2026-08-18, after the second dry run.** Without this, running the
  > passes out of order deletes real data: `--drop-legacy` on an un-migrated
  > root classified the untouched 868 KB `check-progress.jsonl` (and the 7.8 MB
  > `op-log.jsonl`) as "a stray left by a rotation across the shim" and planned
  > an unlink. A stray is only a stray *if a shim exists to have been rotated
  > across* — the classifier assumed the world pass 1 creates.
  >
  > The precondition is judged **per rotation family, not per name**: a real
  > file at a rotation slot is a legitimate stray only if some name in that
  > family is a correct shim. Per-name would flag the genuine
  > `op-log.jsonl.1`-rotated-across-the-shim case as a violation and break the
  > sweep that is actually wanted.
- Rename, never copy — one filesystem, ~45 entries, O(1) each.

The script does IO only. The decision — `(root listing, LEGACY_LAYOUT) → Step[]`
— is a pure `planMigration()` beside the table in
`paths/core/internal/legacy-layout.ts`, so it is unit-testable without a
filesystem and is deleted together with the table.

**The whole thing is self-liquidating**: script, table, `planMigration`, and the
check's symlink-verified grandfathering are all deleted in the drop-legacy push.
Nothing about this migration survives it.

Four cases the implementation must get right:

1. **`logs/` nests into itself.** `rename(logs, .logs-migrating)` → `mkdir logs`
   → `rename(.logs-migrating, logs/gateway)`. Resumable: a `.logs-migrating`
   present on entry means continue from step 2.
2. **Non-empty destination — refuse the whole run.** Destination absent ⇒
   `rename` + `symlink`. Destination present but empty ⇒ `rmdir`, then the same.
   Destination present and **non-empty** ⇒ print every offender with size, mtime
   and child count plus the exact `rm -rf` lines to review, change nothing, exit
   non-zero. No override flag.

   > **Corrected 2026-08-18.** This step originally said "merge the children in;
   > a name already present on the destination side is left in place". That rule
   > silently keeps the WRONG side, and the first real dry run proved it: the new
   > code had already run against the root, so `logs/op-log/op-log.jsonl` held
   > 3.4 KB against the legacy file's **7.8 MB**, and the rule would have
   > stranded the history at the root for `--drop-legacy` to sweep. Worse, every
   > `cpu-slots` child collided, so the legacy dir stayed non-empty and **no shim
   > was planted** — old code flocking `cpu-slots/slot-N.lock` and new code
   > flocking `locks/cpu/slot-N.lock` is two disjoint lock namespaces, silently
   > doubling the host CPU concurrency bound. A merge rule cannot be safe here,
   > because "which side is authoritative" is not a question the migration can
   > answer. Refusing is.
3. **Transient sources.** `duress.latch` and `push-holder.json` may be absent, or
   may reappear after pass 1. Absent is "nothing to do", never an error.
4. **Idempotent, both passes.** `from` already a symlink to `to` ⇒ pass 1 is
   done for that row. `from` absent ⇒ pass 2 is done for that row.

## Code changes

### Declarations

Delete the temporary `legacyLocation` block from all 18 existing
`data-dirs/index.ts` files (keeping the four permanent ones); add
`data-dirs/index.ts` to `infra/attachments`, `infra/secrets`, `infra/duress/latch`,
`database`, `debug`, `debug/profiling/op-log`, `framework/cli`; extend
`infra/launcher`'s (gateway logs + `state/gateway` + `locks/gateway` +
`services/sockets`), `framework/tooling/checks`' (`logs/check-progress`) and
`packages/signal-origin`'s (`logs/signal-origin`).

### Delete the duplicate spellings in `paths.ts`

`SECRETS_DIR`, `STORE_PATH`, `KEY_PATH`, `LEGACY_AUTH_{DIR,BLOB,KEY}`,
`ATTACHMENTS_DIR`, `REPORTS_DIR`, `PROTOTYPES_DIR`, `COST_USAGE_DIR` (lines
167-186) and their re-exports from both barrels. These are a *second* spelling of
directories the registry already owns — leave them and they keep pointing at the
old spot after the move. `REPORTS_DIR` and `COST_USAGE_DIR` already have zero
consumers. Keep `SINGULARITY_DIR`, `WORKTREES_DIR`, `BACKUPS_DIR` (outside the
root), `worktreeDataDir`, `worktreeArtifacts`.

Consumers to repoint at the `DataDir`: `infra/attachments/server/internal/paths.ts`,
`backup/sources/{attachments,prototypes,secrets,singularity-platform}`,
`infra/secrets/central/internal/{store,key-store,paths,migrate-auth-tokens}.ts`.

### Re-derived paths that must import the one declaration

- `cli/bin/commands/start.ts:16` — `join(SINGULARITY_DIR, "logs")` → `gatewayLogs.path`.
- `cli/bin/commands/serve-app.ts:85` — re-derives `gateway.pid` → `gatewayPidFile(root)`.
- `database/plugins/admin/server/internal/pool.ts:27` — re-derives `database.json` → `DATABASE_CONFIG_PATH`.
- `infra/worktree/server/internal/worktree-op.ts:327` — `PUSH_HOLDER_PATH` →
  `pushPool.slots.file("push-holder.json")`; also fix the stale `push.lock`
  comment at `:308`.
- `cli/bin/admission-valve.ts:183,193-195` — `statSync(join(SINGULARITY_DIR, LATCH_FILENAME))`
  and `watch(SINGULARITY_DIR, …)` must move to the `locks/duress` dir.
- `gatewayPidFile(root)` is parameterized (release previews pass a foreign root),
  so derive its subpath from the declaration the way
  `assetMirrorRelativeToRoot()` already does — do not hardcode it twice.
- The four rotating sinks still name the root, and leaving them would make the
  new `logs/*` declarations dead on arrival: `cli/bin/build-progress.ts`,
  `checks/core/progress-log.ts`, `op-log/server/internal/jsonl.ts`,
  `signal-origin/sink/core/internal/lines.ts`.
- **`framework/tooling/codegen/core/config-origin-gen.ts`** — found during
  implementation, missing from the original plan. `propagateConfigToUser` and
  `readEffectiveConfigFromDisk` each do
  `join(opts.singularityDir, "config", opts.worktreeName)`: a parameterized
  second spelling of `state/config`. After the move a dev build writes
  `<root>/config/<wt>` while config_v2 reads `<root>/state/config/<wt>` — masked
  by the pass-1 shim, broken at `--drop-legacy` and on any fresh root. Fix at
  **rung 1**: the two functions take the *resolved user-config dir*, not
  `singularityDir`, so the wrong path has no spelling and the derivation moves
  out to callers that can import the declaration legally. A function handed the
  root can name anything under it — that signature is what invited the
  duplicate. Do NOT add a `data-dirs`→`core` boundary exception to preserve it.
  Same treatment for `boot.ts`'s `seedReleaseConfig` and
  `build/serve-composition/server/internal/reset.ts`.
- `cli/bin/paths.ts:13-15` — `PG_DIR = join(SINGULARITY_DIR, "pg")` is a third,
  dead spelling of the cluster (the real one is `postgres`), and `build.ts:332`
  prints a `PG_LOG_FILE` derived from it, naming a file that has never existed.
  Delete both.

### Gateway

`spawnGatewayDaemon` (`launcher/server/internal/boot.ts:465-488`) passes only
`-listen -log-level -log-dir`; `-registry-dir`, `-sockets-dir`,
`-central-routes-file` and `-db-config` fall back to Go-side defaults derived
from the inherited `SINGULARITY_DIR`. Three of those four defaults become wrong
after the move. Fix both sides: **pass all five explicitly from the
declarations**, and update the defaults in `gateway/main.go:66-78` to the new
layout so a hand-run gateway is right too. (`-db-config` already exists —
that half of the design doc is done.)

### Prose and out-of-build writers

- `paths/plugins/display/core/internal/display.ts` — `PROTOTYPES_DIR_DISPLAY` →
  `~/.singularity/apps/prototypes`; same string in the root `CLAUDE.md`,
  `prototypes/CLAUDE.md` and the two prototype agent-launch prompts.
- `sidequests/monitors/fd/fd-monitor.sh:37-38` and
  `worktree-removal/worktree-removal-monitor.sh:25` — repoint at
  `logs/monitors/`. Outside the build, so they break **silently**; nothing
  catches this but this line. (`fd-monitor.sh:168` reads `worktrees/*.json`,
  which does not move.)
- `paths/CLAUDE.md` — replace the "`LEGACY_TOP_LEVEL` is a shrinking to-do list"
  paragraph with the `LEGACY_LAYOUT` table and the migrate command.

### Close the check

Once the top level is seven kind dirs, `paths:no-undeclared-data-dirs` becomes
vacuous — it would never see a hand-made `state/foo` again. Add the second-level
rule in the same commit: **every entry inside a kind dir on disk must be a
declared `<kind>/<name>`**, exempting `deprecated/` (that is the quarantine) and
`worktrees/` (per-worktree, dynamic, owned by `paths.ts` itself). Fold the kind
dirs' listings into `cacheSignature()`.

## Verification

The order matters — **the migration runs before anything is built on the new
code**, because `./equin` executes TypeScript from source, so the command
works in the worktree with no build.

> **The migration must run BEFORE any new-code process touches the root.**
> Learned the hard way: running `./equin check` first was enough to mint
> `cache/check`, `cache/closure`, `locks/cpu` and three `logs/*` files at their
> new homes, which is exactly the non-empty-destination state step 2 above now
> refuses on. Whatever a pre-migration run creates has to be deleted by hand
> before `--apply` will proceed.

1. `./equin check` — expect green, including `type-check`,
   `plugins-registry-in-sync`, `collected-dir-tsconfig-coverage`, and the two
   existing `paths:` checks. This DOES contaminate the root as described above;
   the script will name what to remove.
2. `./equin test plugins/infra/plugins/paths plugins/packages/plugins/host-semaphore`
   — the host-semaphore suite has eight `join(SINGULARITY_DIR, \`${name}-slots\`)`
   assertions that all move; add coverage for `LEGACY_LAYOUT` (every `from` is
   unique, every `to` names a real declaration) and for the migration against a
   temp root: the four cases above, plus a shim round-trip — after `--apply`,
   reading and writing through the legacy path must hit the same bytes as the
   new path, and `--drop-legacy` must refuse when a legacy name is a real
   directory.
3. `bun plugins/infra/plugins/paths/scripts/migrate-data-layout.ts` (dry run) —
   read the plan. This listing is the acceptance test for the mapping.
4. **You:** `kill $(cat ~/.singularity/gateway.pid)`, then the same script with
   `--apply`, then `./equin start`.
5. `ls -l ~/.singularity/` — the seven kind dirs, the four services, and every
   legacy name present as a symlink into its kind dir.
6. **Confirm a stale worktree still works** — this is the point of the shim.
   Pick another agent's worktree that has *not* rebuilt, load
   `http://<that-worktree>.localhost:9000`, and check it still reads its config
   and lists tasks. Its backend is naming `~/.singularity/config` and reaching
   `state/config` through the shim.
7. `./equin check paths:no-undeclared-data-dirs` — green: every legacy name
   verified as a symlink to its declared target.
8. `./equin build` (background), then confirm
   `~/.singularity/worktrees/<wt>/build-status.json` reads `status: ok`.
9. Exercise the moved dirs end-to-end: open the prototypes gallery (reads
   `apps/prototypes`), take a screenshot (writes `apps/attachments`), open
   Settings → Appearance (reads `state/config`), open Debug → Reports (reads
   `state/reports`), and run a second concurrent build (exercises `locks/cpu` +
   `locks/push`).
10. Re-run the script with `--apply` — must be a clean no-op.
11. **Later, once every worktree has rebuilt:** run it with `--drop-legacy` (dry
    run first). Then `ls ~/.singularity/` gives exactly `apps cache deprecated
    locks logs state worktrees postgres sockets zero node`, and a small push
    deletes the script, the table, `planMigration`, and the check's
    grandfathering rule.

## Caveats you should expect

- **The two transient files diverge for one cycle.** A worktree still on old code
  won't see a duress episode, and won't report who holds the push lock. Both are
  safe degradations (see the shim section) and both end at `--drop-legacy`.
- **A stale worktree's prototype watcher may go quiet.** `@parcel/watcher` on a
  symlinked directory is not guaranteed to follow it, so an old backend might
  stop auto-reloading open prototype iframes. The gallery still lists and serves
  correctly — it reads through the shim. Cosmetic, and gone on rebuild.
- **A remote deployed instance keeps the old layout** until the script is run
  there too — which, since it is a script and not a shipped command, means
  copying it over for the one run. A *fresh* release install is unaffected:
  `launch.ts` mints its data root from nothing, so every directory lands at its
  kind path natively.
- `auth/` holds only a 32-byte `.key`; `tokens.json.enc` is long gone, so
  `migrateLegacyAuthTokens` can only ever return `"noop"`. It is moved to
  `state/auth` rather than quarantined, to keep the diff honest — deleting the
  legacy-auth code path is separate work.

## Out of scope

- The design's **step 5** — unexport `SINGULARITY_DIR`, add
  `paths:data-root-not-joined`. Now nearly free: after this change the only
  remaining `join(SINGULARITY_DIR, …)` sites are `worktree-op.ts`'s three
  `mkdirSync` calls and `paths.ts` itself.
- **Step 6** — folding `defineFileSink` and `defineCorpusIndex` onto `DataDir`
  instead of a raw string path.
- Deleting `LEGACY_LAYOUT` once no root anywhere still needs it.
- An audit pane / `./equin clean` driven by `reclaim`.
