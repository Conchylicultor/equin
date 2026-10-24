# `~/.singularity/` layout: a closed set of kinds, declared per owner

## Context

`~/.singularity/` has 64 top-level entries and 51 GB. It was never designed — it
accreted, because `paths.ts` exports `SINGULARITY_DIR` as a plain string and
**37 call sites across ~30 plugins** write `join(SINGULARITY_DIR, "<whatever>")`.
The root is a shared mutable namespace with no owner and no reader.

What the audit found:

- **Apps mint top-level entries instead of one namespace.** `prototypes/`,
  `prototype-thumbnails/` (the cache *for* `prototypes/`, sitting as its
  sibling), `sonata/` (one file), `wallpaper/`, `attachments/`.
- **One primitive minted ten dirs.** `createHostSemaphore` does
  ``join(SINGULARITY_DIR, `${name}-slots`)``
  (`plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts:250`),
  so every concurrency pool silently adds a top-level entry. Ten exist on disk;
  only seven have a live `defineHostPool` — `build-slots`,
  `type-check-worker-background-slots` and `type-check-worker-interactive-slots`
  are stale and nothing noticed.
- **Caches are indistinguishable from durable state.** `closure-cache` (719 M),
  `web-artifacts` (6.2 G), `eslint-closure-cache` (178 M), `check-cache`,
  `tsbuildinfo`, `asset-mirror` sit next to `secrets.json.enc` and `config/`.
  Nothing on disk says which are the only copy. ~7 GB is unreclaimable without
  reading source.
- **25 loose files at the root**, including four rotations of a log nobody
  writes any more.
- **Nine orphans, ~1 GB**, with zero references left in the repo:
  `eslint-closure-cache/`, `op-wedge-captures.log{,.1,.2,.3}`, `wedge-repro/`,
  `wedge-captures-manual/`, `push-contention.jsonl`, `build-log.jsonl`,
  `push-8x3g-{detached.log,run.sh}`, `scripts/`, plus a hand-made 796 MB pg dump
  in `backups/`.

None of this was visible because **nothing has ever read the directory as a
whole**. `paths:no-hardcoded-paths` catches `homedir()` and `/Users/…`;
`paths:no-inlined-worktree-artifacts` protects the `worktrees/<name>` layout.
Neither says anything about minting a new top-level entry, which is the actual
failure mode.

**Intended outcome:** the top level becomes a closed set of seven kinds, every
directory under it is declared by exactly one owning plugin, and a check fails
on any entry that is not declared — so the next orphan is loud on the day it
appears rather than a year later.

## Decisions taken

| Question | Decision |
|---|---|
| Move scope | Everything **except live services**. `postgres/` (35 G), `sockets/`, `zero/`, `node/` stay physically put and are declared with an explicit `legacyLocation`. |
| API strictness | **Unexport `SINGULARITY_DIR`.** `defineDataDir()` is the only way to a path under the root; a separate `dataRoot()` serves the child-process passthrough. |
| Orphans | **Moved by hand into `deprecated/`**, not deleted. `deprecated` is a declared kind with a TTL, and is the quarantine the check drains into. |

## Target layout

```
~/.singularity/
├── apps/<app>/          prototypes, sonata, wallpaper, attachments   (user content, reclaim: never)
├── worktrees/<name>/    unchanged — the existing good precedent
├── services/            DECLARED, NOT MOVED: postgres, sockets, zero, node
├── state/<owner>/       config, secrets, releases, cost-usage, crashes, reports,
│                          push-holder.json, central-routes.json, database.json, auth
├── cache/<owner>/       check, closure, tsbuildinfo, web-artifacts, asset-mirror,
│                          layout-lab, prototypes-thumbnails, signal-origin-native
├── locks/<owner>/       all 10 *-slots dirs, push.lock, duress.latch, gateway.pid
├── logs/                already top-level; absorbs op-log.jsonl, build-progress.jsonl*,
│                          check-progress.jsonl*, signal-origin.jsonl.
│                          Gateway's per-worktree logs move under logs/gateway/
└── deprecated/          quarantine for entries with no live owner (reclaim: ttl 90d)
```

Two things this buys on day one: `cache/` and `locks/` become reclaimable
wholesale (~7 GB, and ten dirs collapse to one), and `prototype-thumbnails`
lands at `cache/prototypes-thumbnails` where its relationship to
`apps/prototypes` is visible.

## The API

New file `plugins/infra/plugins/paths/core/internal/data-dir.ts`.

```ts
/** The closed set of top-level kinds. Adding one is a reviewed edit to this union. */
export const DATA_DIR_KINDS = [
  "apps", "worktrees", "services", "state", "cache", "locks", "logs", "deprecated",
] as const;
export type DataDirKind = (typeof DATA_DIR_KINDS)[number];

/** What it costs to delete this directory. The answer `du` can never give you. */
export type ReclaimPolicy =
  | { kind: "safe" }                          // rebuilt on demand; rm -rf is free
  | { kind: "restart" }                       // safe once the owning service stops
  | { kind: "never"; reason: string }         // user content / secrets
  | { kind: "keep"; keep: number }            // newest N run-id groups
  | { kind: "ttl"; ttlDays: number };

export interface DataDirSpec {
  kind: DataDirKind;
  /** The ONE caller-supplied segment. Must match /^[a-z0-9][a-z0-9-]*$/. */
  name: string;
  /** Owning plugin path, e.g. "framework/tooling/checks". */
  owner: string;
  /** What lives here — rendered by the audit surface. */
  description: string;
  reclaim: ReclaimPolicy;
  /**
   * Physically NOT under `<kind>/`. Set ONLY for the grandfathered live
   * services (postgres, sockets, zero, node), whose move would require
   * stopping the cluster. Carries the reason; the check honours it.
   */
  legacyLocation?: { path: string; reason: string };
}

export interface DataDir {
  readonly spec: DataDirSpec;
  /** Absolute path. A GETTER — see "lazy resolution" below. */
  readonly path: string;
  file(...segments: string[]): string;
  /** mkdir -p, returns the path. */
  ensure(): string;
}

export function defineDataDir(spec: DataDirSpec): DataDir;
export function getDataDirs(): ReadonlyMap<string, DataDir>;   // key: `${kind}/${name}`

/**
 * The data root ITSELF, for handing to a child process as its SINGULARITY_DIR.
 * NOT for joining — `join(dataRoot(), …)` is exactly what defineDataDir exists
 * to replace, and `paths:data-root-not-joined` fails on it.
 */
export function dataRoot(): string;
```

**Registry discipline: exactly-once, throws on duplicate `${kind}/${name}`** —
the `defineFileSink` / `declareGrowthBound` discipline
(`plugins/infra/plugins/file-sink/core/internal/file-sink.ts:124`), not
`defineHostPool`'s dedup-if-identical. Two owners claiming one directory is
always a bug.

**Lazy resolution.** `path` is a getter, never a value frozen at module eval —
the same reason `webDistDir()` is a function today
(`paths/core/internal/paths.ts:297`). `SINGULARITY_DIR` is set by the release
launcher before it imports path-dependent modules, and `defineDataDir` runs at
consumer module eval, which is earlier still. A frozen const reintroduces the
bug that made releases report a null build id.

## Enforcement

Three layers. The first two are new; the third already exists.

### 1. `paths:data-root-not-joined` — the root becomes unjoinable

`SINGULARITY_DIR` is deleted from both `paths/core/index.ts` and
`paths/server/index.ts`. The constant stays module-private inside
`core/internal/paths.ts`; `dataRoot()` is the only export of the root.

A grep check (same shape as the existing `paths/check/index.ts`, reusing
`grepCode` from `@plugins/framework/plugins/tooling/plugins/checks/core`,
signature at `checks/core/grep-code.ts:15-27`) fails on `join(dataRoot()`,
`` `${dataRoot()}/ ``, and on `process.env.SINGULARITY_DIR` outside a small
allowlist (paths itself, `serve-app.ts`'s presence guard, the sentinel test).

This is modelled on `checks/plugins/host-pools-declared/check/index.ts`, which
bans importing the host-semaphore barrel anywhere outside `host-admission` —
the established way this codebase makes a primitive the only door.

### 2. `paths:no-undeclared-data-dirs` — the check that has never existed

Reads the **real** `~/.singularity/`, diffs `readdirSync` against
`getDataDirs()`, and fails on any entry that is neither declared nor inside
`deprecated/`. This is the piece whose absence let nine orphans accumulate.

- `scope: "deploy"` with a `cacheSignature()` — the sanctioned way for a check
  to touch the live filesystem (`framework/tooling/core/types.ts:51-139`;
  precedent: `checks/plugins/type-check/check/closure-cache.ts` already
  read/writes under the real root).
- **Enumeration without importing every plugin:** declarations live in a new
  `plugins/<path>/data-dirs/index.ts` collected dir, default-exporting
  `DataDir[]`, auto-discovered by codegen exactly like `check/` and `fixtures/`
  (`codegen/core/plugin-registry-gen.ts:117-122`). The check loads them via
  `loadCollectedDir` — the same mechanism `loadAllChecks` uses
  (`checks/core/runner.ts:66-73`). A plugin imports its own dir from its own
  `data-dirs/` folder, so no cross-plugin edge is created.
- Requires registering `data-dirs` as a runtime in
  `framework/tooling/plugins/boundaries/boundary-config.ts` and adding a
  tsconfig glob (the `collected-dir-tsconfig-coverage` check enforces this — see
  the wiring footgun documented in `primitives/css/layout-harness/CLAUDE.md`).

### 3. `paths:no-hardcoded-paths` — unchanged

Already bans `homedir()` / `/Users/` / `~/.singularity` outside the owner. Its
`ALLOWED_PATHS` list needs the new `data-dir.ts` added.

## Fixing the ten-slot-dirs generator

One edit, at the source. `createHostSemaphore` stops deriving its own path;
`defineHostPool` (`infra/host-admission/server/internal/pool.ts:109-165`) passes
it a `locks/<id>` dir it declared. Every pool then lands under `locks/` with no
change at any of the seven call sites (`cpu`, `push`, `worktree-mutate`,
`heavy-read`, `browser-fetch`, `db-fork`, `layout-geometry`).

The same treatment applies to the other primitives that take a caller-built
absolute path today — they should take a `DataDir`, not a string:
`defineFileSink` (`FileSinkSpec.path`), `defineCorpusIndex`
(`CorpusIndexSpec.indexPath`).

## The non-TypeScript writers

A TS API cannot police these. Handled individually:

| Writer | Handling |
|---|---|
| `gateway/main.go` | Every derived path is **already a flag** with a derived default (`-log-dir` :55, `-registry-dir` :57, `-sockets-dir` :61, `-central-routes-file` :64). The launcher passes them resolved; the Go-side defaults become a fallback. Also: consolidate the **two independent `SINGULARITY_DIR` reads** (`main.go:50-54` and `:138-142`) into one helper. |
| `gateway` `database.json` | `main.go:143` is the one path with **no flag** — add `-db-config`. Small Go change; removes the last underived path. |
| `tauri/src-tauri/src/lib.rs` | Sets only the root (`app_data_dir/data`, `lib.rs:88`); knows no subpath. **No change.** |
| `launch.ts` (compiled release) | Sole author of first-boot layout. Its `??=` env roots (`launch.ts:16-89`) and the `seedReleaseAssetMirror` / `seedReleaseConfig` targets move to the new kind paths. |
| `deploy/deployments/core/derive.ts` | Treats the remote `dataDir` as **opaque** — verified: `converge-script.ts:152` emits only `SINGULARITY_DIR=${t.dataDir}`, never a subpath. **No change.** |
| `sidequests/fd-monitor/fd-monitor.sh:37-38,168` | Hardcodes `logs/` and `worktrees/*.json`. Outside the build, so it breaks **silently**. Update by hand; noted here so it isn't missed. |

## Migration

**Where it runs: the launcher, before the gateway spawn** —
`plugins/infra/plugins/launcher/server/internal/boot.ts`. This is the one moment
when nothing in the cluster has a file open. A server `onReady` (the
`migrateLegacyAuthTokens` precedent,
`infra/secrets/central/internal/migrate-auth-tokens.ts:15-52`) is the wrong
mount here: every worktree backend boots concurrently, and a rename of `state/`
out from under a peer that later reopens the old path is a real window.

Mechanics, following the two existing precedents:

- Idempotent, gated on a `.layout-version` marker file at the root.
- Host-singleton only (`isHostSingleton()`).
- **Rename, never copy** — same filesystem, O(1) per entry, ~40 entries. Well
  inside any budget, and no 51 GB copy.
- Races tolerated the way `seedTemplate` does
  (`apps/prototypes/plugins/files/server/internal/seed.ts:21-39`): `ENOTEMPTY` /
  `EEXIST` means a peer won.
- Anything unrecognized goes to `deprecated/` rather than failing the boot —
  loud in the check, not fatal at startup.
- Live services are skipped by construction (they carry `legacyLocation`).

## Orphans — manual, into `deprecated/`

Not part of the implementation. Run by hand; every one of these has **zero code
references** in the repo:

```bash
cd ~/.singularity && mkdir -p deprecated
mv eslint-closure-cache wedge-repro wedge-captures-manual scripts deprecated/
mv op-wedge-captures.log op-wedge-captures.log.1 op-wedge-captures.log.2 \
   op-wedge-captures.log.3 push-contention.jsonl build-log.jsonl \
   push-8x3g-detached.log push-8x3g-run.sh \
   check-progress.jsonl.preformat.bak .DS_Store deprecated/
# Stale semaphore dirs — no live defineHostPool declares these three:
mv build-slots type-check-worker-background-slots \
   type-check-worker-interactive-slots deprecated/
```

`backups/` (796 MB hand-made pg dump + a block-id CSV, Aug 8) is left alone —
only you know whether it is still wanted.

## Files to change

**New**

- `plugins/infra/plugins/paths/core/internal/data-dir.ts` — the API above
- `plugins/infra/plugins/paths/check/index.ts` — two checks appended to the
  existing default-exported array
- `plugins/<path>/data-dirs/index.ts` — one per owning plugin (~30)
- `plugins/infra/plugins/launcher/server/internal/migrate-layout.ts`

**Modified — the pattern, repeated ~37 times**

Every `join(SINGULARITY_DIR, "<name>")` becomes a `defineDataDir` in that
plugin's `data-dirs/index.ts`, and the consumer reads `.path` / `.file(…)`.
Representative sites, one per kind:

- `framework/tooling/plugins/checks/core/cache.ts:18` → `cache/check`
- `framework/tooling/plugins/web-artifacts/core/internal/store.ts:20` → `cache/web-artifacts`
- `packages/plugins/host-semaphore/server/internal/host-semaphore.ts:250` → `locks/<id>` (passed in)
- `apps-core/…/floating/wallpaper/server/internal/store.ts:10` → `apps/wallpaper`
- `apps/sonata/…/midi/plugins/folders/server/internal/reconcile.ts:68` → `apps/sonata`
- `debug/profiling/plugins/op-log/server/internal/jsonl.ts:6` → `logs/op-log`
- `release/plugins/bundles/server/internal/out-dir.ts:27` → `state/releases`
- `config_v2/server/internal/config-dir.ts` → `state/config`

**Modified — one-offs**

- `paths/core/index.ts` + `paths/server/index.ts` — drop `SINGULARITY_DIR`, add
  `defineDataDir` / `getDataDirs` / `dataRoot`
- `paths/plugins/display/core/internal/display.ts` —
  `PROTOTYPES_DIR_DISPLAY` becomes `~/.singularity/apps/prototypes`. Also
  referenced in prose in the root `CLAUDE.md`, `prototypes/CLAUDE.md`, and the
  two prototype agent-launch prompts.
- `framework/plugins/cli/bin/paths.ts` — re-exports `SINGULARITY_DIR`; note its
  own docblock (`:6-10`) already warns that re-deriving here is how a third
  divergent copy of a path was born. Worth checking during implementation
  whether its `PG_DIR = join(SINGULARITY_DIR, "pg")` is dead — the embedded-PG
  plugin uses `postgres`, and only `postgres/` exists on disk.
- `gateway/main.go` — flag plumbing + the duplicated root read
- `framework/plugins/cli/bin/commands/{build,deploy,release,serve-app}.ts` and
  `internal/compose-serve.ts` — `singularityDir: SINGULARITY_DIR` becomes
  `dataRoot()`
- `boundary-config.ts` + a tsconfig glob for the `data-dirs` collected dir

## Verification

1. `./equin check paths:no-undeclared-data-dirs` — expect **green** only
   after every dir is declared. Before the declarations land it should list each
   undeclared entry by name; that listing is itself the acceptance test for the
   check.
2. `./equin check paths:data-root-not-joined` — green, and confirm it goes
   **red** on a deliberate `join(dataRoot(), "x")` added to a scratch file.
3. `./equin check` — full suite, especially `type-check`,
   `plugins-registry-in-sync`, `collected-dir-tsconfig-coverage`, and the two
   existing `paths:` checks.
4. `./equin build` (background) — the launcher migration runs on the way
   up. Then confirm the deploy receipt at
   `~/.singularity/worktrees/<wt>/build-status.json` reads `status: ok`.
5. `ls ~/.singularity/` — expect **8 entries** (the seven kinds plus
   `worktrees/`), with `postgres/`, `sockets/`, `zero/`, `node/` still present
   and declared via `legacyLocation`.
6. Re-run `./equin build` — the migration must be a no-op the second time
   (marker present). Confirm no rename attempts in the launcher log.
7. Exercise the moved dirs end-to-end: open the prototypes gallery (reads
   `apps/prototypes`), take a screenshot (writes `apps/attachments`), open
   Settings → Appearance (reads `state/config`), and run a second concurrent
   build (exercises `locks/cpu` + `locks/build`).
8. `bun plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.test.ts`
   via `./equin test plugins/packages/plugins/host-semaphore` — its eight
   `join(SINGULARITY_DIR, \`${name}-slots\`)` assertions all move.
9. `./equin test plugins/infra/plugins/paths` — the two existing check
   tests plus new coverage for `defineDataDir` (duplicate-name throw, name
   validation, lazy root resolution under a changed `SINGULARITY_DIR`).

## Sequencing

Six commits, each independently buildable:

1. `defineDataDir` + `dataRoot` + the `data-dirs` collected dir and its codegen
   wiring. Nothing consumes it yet; `SINGULARITY_DIR` still exported.
2. `paths:no-undeclared-data-dirs`, seeded with a `LEGACY_TOP_LEVEL` allowlist
   covering all 64 current entries. Green immediately, and the allowlist is the
   visible to-do list.
3. Declarations, plugin by plugin — each one moves a name out of
   `LEGACY_TOP_LEVEL` into a real declaration. Still no files move.
4. The launcher migration + gateway flag plumbing. **This is the commit where
   the disk changes**; verify against steps 4-7 above before continuing.
5. Delete `SINGULARITY_DIR` from both barrels; add
   `paths:data-root-not-joined`. Only possible once step 3 is complete.
6. Fold `defineFileSink` / `defineCorpusIndex` onto `DataDir` instead of a raw
   string path.

Step 4 is the only one that is hard to reverse. It is a rename on one
filesystem with a marker file, so rolling back is renaming the seven kind dirs
back and deleting the marker — but it is worth landing on its own, with nothing
else in the commit.

## Deliberately out of scope

- **Moving `postgres/`, `sockets/`, `zero/`, `node/`.** Declared with
  `legacyLocation`, physically untouched. Moving them needs cluster and gateway
  downtime and belongs in its own change.
- **Unifying the two prune implementations.** `prune-artifacts.ts`
  (writer-invoked, keep-N families) and `closure-cache.ts` (prune-on-open,
  age+count) are independent solutions to one problem. `ReclaimPolicy` gives
  them a common vocabulary; actually merging them is follow-up work.
- **A Debug pane listing owner / purpose / size per dir.** The registry makes it
  nearly free, and `./equin clean` driven by `reclaim` likewise — both
  are worth doing, neither is needed for this change to be correct.
- **`config/<worktree>/`.** Per-worktree data living under a host-global
  `state/config`, reaped by `worktree-cleanup`
  (`debug/worktree-cleanup/server/internal/reap.ts:60`). It is backed up and
  user-facing; re-homing it under `worktrees/<name>/` is a separate question.
