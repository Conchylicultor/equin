# paths

The single source of truth for **where things are on this machine**: the repo
root, the user's home, the Claude corpus, the per-worktree artifact layout, and
the data root (`~/.equin/`). The repo root itself is the `repo-root`
sub-plugin's `REPO_ROOT` — the one way a file reaches the repo; counting
`../` from a file's own location is a lint error there.

`core/` here means **runtime-neutral Node, not web-safe** — it reaches
`node:os` / `node:fs` / `node:path` and must never be imported from `web/`
(a jsdom suite included) — `boundaries:web-loads-portable` fails any
browser-realm module whose import reaches it. A
browser that needs to *name* a directory reads the string literals in the
`display` sub-plugin instead.

## Where the root is

`EQUIN_DIR` when set (a release bundle, a preview, a VM). Otherwise it is
decided by what is **installed**, not by the code's version
(`core/internal/data-root-layout.ts`, `dataRootLayout()`):

| on disk | root |
|---|---|
| no legacy dir (`LEGACY_IDS.dataDirName`) | `~/.equin` — a fresh install, or a migrated one |
| the legacy dir is a link to `~/.equin` | `~/.equin` (a migration whose leftover scan kept the link) |
| the legacy dir (or a link elsewhere), no `~/.equin` | the legacy dir — an install not yet migrated |
| both, separate | `DataRootSplitError`, loudly: a human decides |

Deciding by version would point new code at an empty `~/.equin` on every
machine that has not migrated. The same rule is mirrored in `gateway/dataroot.go`
(with the same test cases), `install.sh` and the host scripts listed as
`dataDirName` mirrors. Only `./equin data-dir migrate` changes it, with the
app stopped. The local backups dir (`backupsDir()`, outside the root) follows
the same layout.

## The data root

The home layout is a fact of the disk, and `dataRoot()` / every `DataDir`
getter is read synchronously, from hundreds of call sites, in every kind of
process. So the layout is **decided once per process TREE, at its root, and
carried by the environment** (`EQUIN_DATA_ROOT_LAYOUT`: `current`,
`current-legacy-link` or `legacy` — `HOME_LAYOUT_TOKENS`; both roots derive
from the home dir). `dataRootLayout()` is then an environment read on any
thread: `EQUIN_DIR` → custom; the declaration → its layout; an unknown token
throws.

A tree's root decides from the disk with `declareDataRootLayoutSync()` (it
always re-reads the disk — its parent may be a long-lived process holding a
pre-migration answer) and writes the variable; with `EQUIN_DIR` set, or on a
split, it removes an inherited one instead. The roots:

| process tree | who declares |
|---|---|
| `./equin` and everything it starts | the wrapper sources `scripts/declare-data-root.sh` (the shell twin, held to the TS rule case for case by `declare-data-root-sh.test.ts`); the CLI's `bin/index.ts` decides again in-process (a CLI started without the wrapper); a split install stays undeclared, so the verb that reads a path throws `DataRootSplitError` and `data-dir migrate` still runs to explain it (the hooks do the same) |
| the gateway's children (every backend, Postgres / PgBouncer start scripts) | `gateway/dataroot.go` adds it to every child's base env (`dataRootLayoutEnv`) |
| a backend (main, worktree, central) | the first import of its serving entry (`server-core/bin/declare-data-root.ts`, `central-core/bin/declare-data-root.ts`) — before it listens, so a gateway that predates the declaration still leaves the backend's thread decided |
| a Claude Code hook | `guards/bin/declare-data-root.ts`, first import of `hook.ts` / `stop-hook.ts` |
| an SDK agent (and the claude it runs) | `runtime-sdk/bin/declare-data-root.ts`, first import of `agent.ts` — the backend starts it under `env -i` with the agent session's allowlist, so nothing reaches it from the gateway |
| `bun test` | `test/bun-preload.ts` |
| a release | `EQUIN_DIR`, set by the launcher before anything reads a path |

**Why the environment of the tree, not just of the process.** A Bun child
spawned with no explicit `env` gets its parent's STARTING environment, never a
`process.env` write — and so does a `new Worker` without `{ env }` (measured,
Bun 1.4.4). A declaration made in-process reaches only `infra/spawn` children
(they pass `process.env`) and `node:child_process` ones. That is why the
wrapper and the gateway, which start their trees, put it in the starting
environment, and why an in-process declaration is for the process itself. A
backend's workers get it anyway: `defineDaemon`'s `spawnWorker` hands a
worker the environment as it is at the spawn (`node:worker_threads` already
does).

**An undeclared process throws on its first path read**
(`DataRootUndeclaredError`, naming its pid and argv): `dataRoot()` is a pure
environment read, and a missed root is fixed at that root — its entry point, or
the spawner that dropped the variable from its child's environment — never by
deciding on the spot, on whatever thread asked. The one sanctioned undeclared
process is a root that found a split install (the CLI, the hooks): there every
path read rethrows the `DataRootSplitError` its declaration found. The
`movedFrom` inspection behind the `DataDir` getters (`core/internal/data-dir.ts`)
is the remaining `blocking-fs/sync-named` debt.

**Moving an install over:** `./equin data-dir migrate` (the `root-migration`
sub-plugin) — dry run by default, `--apply` executes. It refuses while any
op or agent runs. With `--apply`, it stops the app, renames the root (and the
backups dir) and leaves a link back while it rewrites every stored copy of the
old path, by one rule: a stored value that STARTS with the old prefix is a path.
That covers every database in the cluster, the text files under the root,
links, and Claude Code's transcript dirs. History (logs, agent events,
`*.jsonl`, run transcripts) is never rewritten, because it is read by byte
offset. Cache entries holding the old path are dropped. The link is removed
once a scan finds nothing left. Finally it relabels the gateway's service and
starts the app.

## Three questions that look alike

`~/.equin/worktrees/` is host-global, so "which namespace?" has three
different right answers depending on who is asking:

| question | answer | who may ask |
|---|---|---|
| which namespace is **this runtime** the server for? | `runtimeNamespace()` (`infra/runtime-identity`) | a gateway-spawned backend, or an exec child its spawner told |
| which namespace does **this checkout** own? | `checkoutNamespace(root)` | the CLI, checks |
| which deploy did this checkout **publish**? | `resolveCheckoutDeploySync(root)` | anything driving the deployed app |

The first does not live in this plugin at all, and that split is the point. It is
declared once, at a process's entry point, from the `--namespace` its spawner
passed — so a process that was told nothing has no answer and asking THROWS. It
used to ride in an environment variable, which every agent pane inherited from
main's backend: inside a worktree it answered the main namespace, so a CLI or an e2e
script that read it acted on MAIN's deploy while reporting success. See
[`runtime-identity`](../runtime-identity/CLAUDE.md).

The third is a READ, not a derivation, and that is what makes it safe.
`./equin build` records the checkout that published a namespace in that
namespace's own `spec.json` — the `server` field, an absolute path ending in
`SERVER_CORE_RELATIVE` — and `deploysForCheckoutSync(root)` matches every registered
spec against it. So a checkout that has never been built resolves to `none`
rather than to somebody else's app, and a `--composition` build's namespace
(`sonata.att-x`, which shares no label with the checkout) is found by the same
read that finds the plain one. A namespace dir with no `spec.json` is skipped —
several always are; a spec that exists and cannot be USED — unparseable, or
naming a `server` path that will not resolve — is collected and judged after the
whole scan, warned about when something else matched and raised only when
nothing did. That judgement covers the whole spec, both reads: one bad entry in
a host-global registry of ~70 must not be able to break every checkout on the
machine.

**Where it looks: the specs a build could have written, not the registry.**
`lookupCheckoutDeploy(root, composition?)` reads only the namespaces a build of
this checkout can mint — `namespaceFor(composition, …)` as the main checkout and
as a worktree named by the root's basename (as given and through symlinks) —
and still decides by each spec's `server` field, so a candidate somebody else
published is simply not a match. A few reads, where the scan read and resolved
~180 specs synchronously (3–5 s stalls on main per browser-MCP call under host
load). `resolveCheckoutDeploySync` is that lookup, plus the scan on a miss only —
the refusal names what this checkout DOES serve, which only the whole registry
can say. A spec naming this checkout under a name no build mints (a
`serve-app --name`, a renamed namespace) is not resolved, only listed.

## The data root is a registry, not a string

Everything under `~/.equin/` is a **declared directory with an owner**.
Nothing joins the root by hand — that is how it accreted 60+ entries nobody
could classify, of which nine were orphans with no reference left in the repo.

```ts
import { defineDataDir } from "@plugins/infra/plugins/paths/core";

export const checkCache = defineDataDir({
  kind: "cache",
  name: "check",
  owner: "framework/tooling/checks",
  description: "Recorded check verdicts, keyed by working-tree hash",
  reclaim: { kind: "safe" },
});

await checkCache.ensure();           // mkdir -p off the thread, returns the path
checkCache.ensureSync();             // the same, holding the thread: CLI / check / bin only
checkCache.file("abc123.json");      // a path INSIDE it
```

`ensure()` is asynchronous (`fs/promises` mkdir, the stat only to explain a
failure), so a backend can call it on every write; `ensureSync()` is its
blocking twin, refused on a backend by `blocking-fs/no-sync-fs` like any
`*Sync`. `.path` and `.file()` touch no disk once a process has resolved its
data root and its declared moves (both memoized per process).

### The kinds are a closed set

`apps` · `worktrees` · `services` · `state` · `cache` · `locks` · `logs` ·
`deprecated`.

A kind is a **reclaim class** — the answer to "may I delete this whole subtree?"
that a size listing can never give you. `cache/` and `locks/` are reclaimable
wholesale; `state/` and `apps/` hold the only copy of something. Adding a kind is
a reviewed edit to `DATA_DIR_KINDS`, and that friction is the point.

### The root itself is unjoinable

`dataRoot()` returns the root, and its **only** legitimate use is handing that
root to a child process as its `EQUIN_DIR` (the gateway spawn, a release
launch, a remote deploy's env line) — or reporting it to a human.
`join(dataRoot(), …)` is exactly what `defineDataDir` exists to replace: a
joined root is an undeclared directory, which is the failure mode the registry
is here to make impossible.

`paths:data-root-not-joined` enforces it: no `join`/`resolve`/`` `${…}/` `` of
`dataRoot()`, and no **read** of `process.env.EQUIN_DIR` outside a
four-entry allowlist (a raw env read is a second derivation of the root).
**Writing** that var — `=`, `??=`, an `env: {…}` key — is the handoff to a child
and is never flagged; `*.test.ts` is exempt, since a test owning its own root is
correct.

To name a declared location under a root that is **not** this process's own (a
preview's `/tmp` data dir, a fresh install's), use `relativeToDataRoot(dir, …)`.
It takes a `DataDir`, so the answer comes from the declaration.

`dataRoot()` is a **function**, and `DataDir.path` is a **getter** — never a
value frozen at module eval. `EQUIN_DIR` is env-overridable and the release
launcher sets it *before* importing anything path-dependent, while
`defineDataDir` runs at consumer module eval, which is earlier still. This is the
same reasoning that made `webDistDir()` a function; the frozen-const form there
is what once made a release report a null build id.

### Adding a new data dir

0. Inside an app? Durable content does not get a new dir — take an area of the
   app's one dir (`<app>Dir.subdir("<area>")`, see below).
1. Create `plugins/<your-plugin>/data-dirs/index.ts` and default-export a
   `DataDir[]` of your `defineDataDir(...)` calls. `data-dirs` is a
   **collected dir** (marked by `defineCollectedDir("data-dirs")` in this
   plugin's `core/collected-dir.ts`), auto-discovered by codegen exactly like
   `check/` — no registry edit, no codegen edit.
2. Import the declaration from your own plugin's code and read `.path` /
   `.file(…)` / `await .ensure()`. Never re-derive the path.
3. Run `./equin build`, then `./equin check paths:no-undeclared-data-dirs`.

A directory is declared **exactly once** — a duplicate `${kind}/${name}` throws,
mirroring `defineFileSink`. Two owners claiming one directory is always a bug.

A declaration is made **only** in a `data-dirs/index.ts`, and its `owner` is the
declaring plugin's path minus its `/plugins/` segments
(`apps/plugins/prototypes/plugins/thumbnails` → `apps/prototypes/thumbnails`).
A call anywhere else is invisible to the collected dir, so the manifest and the
audit miss it. Both are enforced by `paths:app-data-dirs` (below).

### One data dir per app: `defineAppDataDir`

Each app owns **exactly one** data dir, `apps/<app>/`, and everything the app and
its sub-plugins keep durably lives inside it. `defineDataDir` refuses the `apps`
kind (a type error, and a throw past a cast); an app's dir is spelled only from
the app's identity, at the **app root** (`plugins/apps/plugins/<id>/data-dirs/index.ts`):

```ts
export const prototypesDir = defineAppDataDir(prototypesApp, { owner: "apps/prototypes", description: "…" });
```

- No `name` (it is the app id), no `reclaim` (always `never`). Re-derivable
  output still goes to `cache/`, declared normally.
- Sub-plugins import the root's declaration. The app's `shell/core` must never
  import it back: the root's `data-dirs` imports `shell/core`, so that edge is a cycle.
- A second `defineAppDataDir` for the same app throws, naming the fix.

**A sub-plugin's space is an area, not a directory:** `desktopDir.subdir("wallpaper")`
returns `{ path, file(…), ensure(), ensureSync() }` — one lowercase segment, NOT registered.

### Moving a declared dir: `movedFrom`

A declaration records where its bytes used to live, and **resolution performs
the move** — no script:

```ts
defineDataDir({ kind: "state", name: "attachments", …, movedFrom: [{ from: "apps/attachments" }] });
defineAppDataDir(desktopApp, { …, movedFrom: [{ from: "apps/wallpaper", to: "wallpaper" }] });
```

`from` is the old `<kind>/<name>`; `to` is the area the bytes land in (absent =
the whole dir). Every read (`.path`, `.file()`, `.ensure()`, a `subdir()`) goes
through the move first, so nothing reads the new spot before the bytes are there:

| on this root | resolves to |
|---|---|
| `from` absent, or a symlink (**settled**) | new location — memoized per root |
| `from` a real dir, destination absent (**pending**) | the mover `rename`s + plants a relative symlink at `from`, then new; every other process: OLD |
| `from` a real dir AND destination exists (**split copy**) | throws on every read — a human merges |

**Only the host singleton running merged code moves**: the main backend from
the main checkout, or a release's backend on its own root. Not
`isHostSingleton()` alone — every process an agent pane spawns inherits
`WORKTREE` set to the main namespace, so a worktree's CLI, tests and hooks read as
the singleton, and an unmerged branch must never mutate the shared root. The
**symlink** keeps older checkouts on the same bytes instead of a fresh empty dir.
Not a `LEGACY_LAYOUT` row: that table is top-level, self-liquidating, and its
script refuses while a gateway is alive. Drop a `movedFrom` entry (and its
symlink) once no live checkout declares the old location.

### `paths:app-data-dirs`

Tree-scoped, so it runs in every build, check and push. It calls each generated
`data-dirs` entry's loader itself, pairing every declaration with the plugin that
really made it (the registry has forgotten), and fails on:

- **A** — `apps/<n>` not declared by `apps/plugins/<n>`.
  What makes the structural `app` param honest: `{ id: "prototype-history" }`
  type-checks, and fails here.
- **B** — a `reclaim: never` dir declared inside an app's subtree other than the
  app dir (`state/prototype-history`). Reclaimable kinds are allowed.
- **C** — `owner` ≠ the declaring plugin's path (also catches re-exporting
  another plugin's `DataDir` in your default export).
- **D** — a declaring call outside a `data-dirs/index.ts` (tests and this plugin exempt).

Rules are pure, in `core/internal/app-data-dirs.ts`.

### "Declared" means declared on this MACHINE, not in this checkout

The root is shared by every checkout on the box; a checkout's registry is one
branch's view. So each namespace's backend publishes its own declared set to
`worktreeArtifacts.dataDirs(namespace)` on boot, and the audit reads the union —
an entry another live namespace owns is logged as owned, not failed. Only an
entry nobody on this machine declares is an offender. Two things not to undo:

- The manifest comes from the **evaluated registry**, never from parsing
  `data-dirs/index.ts` — `infra/host/host-admission` mints one `locks/<id>`
  declaration per pool, so a declared name is not always a literal.
- The check is `scope: "host"` and so **does not run during a build**: no
  per-worktree op can assert a root that runs ahead of its own branch. Nor
  does a bare `./equin check` select it: main's hourly `checks.host-audit`
  runs it and files a `host-check` report per failure
  (`plugins/framework/plugins/tooling/plugins/checks/plugins/host-audit`). Run
  it on demand with `./equin check paths:no-undeclared-data-dirs`. A namespace that has never booted
  publishes nothing, so its dirs read as undeclared until it does.

`paths:no-undeclared-data-dirs` reads the REAL root and fails on any top-level
entry that is neither declared nor grandfathered. Grandfathering is driven by
one `LEGACY_LAYOUT` table (`core/internal/legacy-layout.ts`), shared by the
check and by the one-off
`./equin run plugins/infra/plugins/paths/scripts/migrate-data-layout.ts`
(dry-run by default; `--apply` moves bytes and leaves a compat symlink at the
old path; `--drop-legacy` removes it once every worktree has rebuilt), so the
to-do list and the migration plan can't drift. A legacy name passes only if
it's a symlink resolving to its declared target — a real directory there is a
failure, not a tolerated leftover.

**A shim is only planted where one can hold.** It works by standing in for the
BYTES BEHIND a name, so it survives a writer that appends or truncates in place
— and not one that writes the NAME ITSELF: an `unlink`, an atomic
`rename(tmp, name)`, a log rotation renaming `x` to `x.1`. Each of those removes
or replaces the link on its first write, silently splitting old and new code
onto two files. A row whose pre-move writer does that is `move: "unshimmable"`
and states what it `leaves` at the root (`"nothing"` when the writer unlinks,
`"a file"` when it replaces), and the check's expectation is derived from that —
so a row cannot claim a steady state its writer does not produce. Where a shim
IS held and a pre-move writer replaced it anyway, `--apply` rescues the stray
beside its family as `<name>.pre-move-<n>` and re-plants the shim; it discards
neither side, and stops with the sizes when the two readings (a replaced shim,
or the original never moved) are indistinguishable.

The check also polices the second level:
every entry inside a kind directory must itself be a declared `${kind}/${name}`
— or a declared move's old location, passing as its shim or as a pending move
(a split copy fails). Table, script and check rule are all deleted together once `--drop-legacy` has
run everywhere.

### Log claims: `paths:logs-claimed`

A log file grows by construction, so each one must be tied to what keeps it
finite. A data dir declares its log files — `logs: [{ pattern, bound }]` on its
`defineDataDir` (`core/internal/log-claims.ts`): `pattern` is relative to the
dir (`*` within a segment, `**` across; rotations `<file>.N` match implicitly),
`bound` is `file-sink` (`defineFileSink`), `gateway-rotating` (the gateway's
`rotatingWriter`), `rotates-itself` (`how`), `truncate-on-start` (`reason`) or
`debt` (`reason` + the `task` that bounds it). First match wins.

`paths:logs-claimed` (host-scoped, never cached) walks every declared `logs`
and `services` dir — and any other dir that declares claims — and fails on
each `*.log` / `*.jsonl` (and rotation) no claim matches, naming its size; it
logs every debt claim with what it holds. `cache`, `state`, `apps` and
`worktrees` are not scanned (data bounded by reclaim and retention, and a
namespace's registry dir dies with it). Claims ride the data-dirs manifest
(`logClaims`), so a claim another live branch declares excuses its file here.
Written after `postgres.log` (1.7 GB), `pgbouncer.log` (1.4 GB) and 1.9 GB of
reaped namespaces' gateway logs were each found by accident, months in.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Canonical machine paths, plus the boot-time publication of this namespace's declared data-dir set so an audit running in another checkout can tell one of this branch's directories from an orphan.
- Core:
  - Uses: 33 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `packages/timed-fs` ×10
    - `infra/namespace` ×8
    - `infra/launcher/env-names` ×5
    - `infra/host-fs/user-path` ×3
    - `framework/product-name` ×2
    - `infra/runtime-identity` ×2
    - `framework/tooling/collected-dir.defineCollectedDir`
    - `infra/paths/repo-root.REPO_ROOT`
    - `infra/spawn.getMainRepoRoot`
  - Exports (types):
    - `AppIdentity`
    - `CheckoutDeploy`
    - `CheckoutDeployResolution`
    - `CheckoutMinterRead`
    - `CheckoutOwnerRead`
    - `DataDir`
    - `DataDirArea`
    - `DataDirInput`
    - `DataDirKind`
    - `DataDirRef`
    - `DataDirSpec`
    - `DataRootLayout`
    - `LegacyMove`
    - `LogBound`
    - `LogClaim`
    - `MigrationStep`
    - `MovedFrom`
    - `ReclaimPolicy`
    - `ReleaseIdentity`
  - Exports (values):
    - `actAsCheckoutNamespace`
    - `backendEntryFor`
    - `backupsDir`
    - `backupsDirs`
    - `CHECK_ARTIFACTS_RETENTION`
    - `checkoutNamespace`
    - `checkoutRef`
    - `checkoutWorktreeName`
    - `CLAUDE_DIR`
    - `CLAUDE_PROJECTS_DIR`
    - `CLAUDE_SESSIONS_DIR`
    - `CLAUDE_USER_CONFIG`
    - `claudeProjectDirName`
    - `claudeTranscriptPath`
    - `DATA_DIR_KINDS`
    - `DATA_DIR_NAME`
    - `dataRoot`
    - `dataRootLayout`
    - `DataRootSplitError`
    - `declareDataRootLayoutSync`
    - `defineAppDataDir`
    - `defineDataDir`
    - `deploysForCheckoutSync`
    - `getDataDirs`
    - `HOME_DIR`
    - `homeDataRoots`
    - `isHostSingleton`
    - `isRelease`
    - `LEGACY_LAYOUT`
    - `listWorktreeDirsAsync`
    - `listWorktreeDirsSync`
    - `LOG_FILE_RE`
    - `logPatternMatches`
    - `lookupCheckoutDeploy`
    - `lookupCheckoutDeploySync`
    - `planMigration`
    - `PLUGINS_DIR`
    - `pruneWorktreeCheckArtifactsSync`
    - `pruneWorktreeTestArtifactsSync`
    - `publishedLogClaim`
    - `readCheckoutMinter`
    - `readCheckoutMinterSync`
    - `readCheckoutOwner`
    - `readCheckoutOwnerSync`
    - `readHomeDataRootLayoutSync`
    - `relativeToDataRoot`
    - `releaseIdentity`
    - `repoConfigDir`
    - `resolveCheckoutDeploySync`
    - `RUN_TERMINAL_SUFFIX`
    - `SERVER_CORE_RELATIVE`
    - `setReleaseIdentity`
    - `stampCheckoutMinter`
    - `stampCheckoutMinterSync`
    - `toolchainPin`
    - `WORKTREE_SPEC_FILE`
    - `worktreeArtifacts`
    - `worktreeDataDir`
    - `worktreesDir`
- Cross-plugin:
  - Imported by: 127 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra` ×31
    - `apps` ×20
    - `framework` ×18
    - `debug` ×13
    - `conversations` ×7
    - `build` ×5
    - `backup` ×4
    - `plugin-meta` ×4
    - `primitives` ×3
    - `release` ×3
    - `code-explorer` ×2
    - `database` ×2
    - `integrations` ×2
    - `packages` ×2
    - `reports` ×2
    - `stats` ×2
    - `config_v2`
    - `media/film`
    - `menu-bar`
    - `review/plugin-changes`
    - `shell/document-head`
    - `tasks`
    - `toolchain`
- Exemptions:
  - Exempts itself from:
    - `paths:no-hardcoded-paths` — `check/index.ts`, `core/internal/paths.ts` (sanctioned)
    - `paths:no-inlined-worktree-artifacts` — `.` (sanctioned)
    - `paths:data-root-not-joined` — `.` (sanctioned)
    - `boundaries/no-platform-api` — `core/internal/checkout-deploys.ts`, `core/internal/checkout-minter.ts`, `core/internal/checkout-owner.ts`, `core/internal/checkout-ref.ts`, `core/internal/data-dir.ts`, `core/internal/data-root-layout.ts`, `core/internal/data-dirs-manifest.ts`, `core/internal/paths.ts`, `core/internal/prune-artifacts.ts`, `core/internal/toolchain-pin.ts`, `core/internal/worktree-dirs.ts` (debt)
    - `user-path/no-unproven-claim` — `core/internal/paths.ts`, `core/internal/data-root-layout.ts` (sanctioned)
    - `user-path/no-unproven-claim` — `core/internal/checkout-deploys.ts` (sanctioned)
    - `blocking-fs/sync-named` — `core/internal/data-dir.ts` (debt)
- Server:
  - Exports (types):
    - `AppIdentity`
    - `DataDir`
    - `DataDirArea`
    - `DataDirInput`
    - `DataDirKind`
    - `DataDirRef`
    - `DataDirSpec`
    - `MovedFrom`
    - `ReclaimPolicy`
    - `ReleaseIdentity`
  - Exports (values):
    - `actAsCheckoutNamespace`
    - `backupsDir`
    - `BUILD_ARTIFACTS_RETENTION`
    - `CHECK_ARTIFACTS_RETENTION`
    - `checkoutNamespace`
    - `checkoutRef`
    - `checkoutWorktreeName`
    - `CLAUDE_DIR`
    - `CLAUDE_PROJECTS_DIR`
    - `CLAUDE_SESSIONS_DIR`
    - `claudeProjectDirName`
    - `claudeTranscriptPath`
    - `DATA_DIR_KINDS`
    - `dataRoot`
    - `dataRootLayout`
    - `defineAppDataDir`
    - `defineDataDir`
    - `getDataDirs`
    - `GIT`
    - `HOME_DIR`
    - `isHostSingleton`
    - `isRelease`
    - `listWorktreeDirsAsync`
    - `listWorktreeDirsSync`
    - `PGREP`
    - `PLUGINS_DIR`
    - `pruneWorktreeBuildArtifactsSync`
    - `pruneWorktreeCheckArtifactsSync`
    - `pruneWorktreeRunArtifacts`
    - `pruneWorktreeRunArtifactsSync`
    - `PS`
    - `publishDataDirsManifest`
    - `relativeToDataRoot`
    - `releaseIdentity`
    - `repoConfigDir`
    - `RUN_ARTIFACTS_RETENTION`
    - `RUN_TERMINAL_SUFFIX`
    - `RUN_TRANSCRIPT_SUFFIX`
    - `SAMPLE`
    - `SERVER_CORE_RELATIVE`
    - `setReleaseIdentity`
    - `WEB_CORE_RELATIVE`
    - `webDistDir`
    - `worktreeArtifacts`
    - `worktreeDataDir`
    - `worktreesDir`
- Sub-plugins:
  - **`data-files`** — Data files: the files app-owned data dirs hold, on whatever host runs — the DataFiles host service (the computer's disk on the desktop, memory in a browser host) behind defineFileRoot, a root…
  - **`display`** — The human-facing spelling of the data dirs (the `~/…` form a message, an empty state, or an agent prompt writes). Web-safe by construction: string literals only, no node:* and no homedir() — so the…
  - **`repo-root`** — REPO_ROOT — the checkout this code runs from, the one place any file gets it. Derived without counting ../ (its own repo-relative dir is a literal `./equin plugin move` rewrites; a stale one throws…
  - **`root-migration`** — `./equin data-dir migrate`: moves an install's data root from the legacy home dir to ~/.equin (and its local backups beside it) in one run, with every other process of the app stopped — rewrites…

<!-- AUTOGENERATED:END -->
