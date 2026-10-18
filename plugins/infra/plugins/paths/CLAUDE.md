# paths

The single source of truth for **where things are on this machine**: the repo
root, the user's home, the Claude corpus, the per-worktree artifact layout, and
the singularity data root (`~/.singularity/`).

`core/` here means **runtime-neutral Node, not web-safe** — it reaches
`node:os` / `node:fs` / `node:path` and must never be imported from `web/`. A
browser that needs to *name* a directory reads the string literals in the
`display` sub-plugin instead.

## Three questions that look alike

`~/.singularity/worktrees/` is host-global, so "which namespace?" has three
different right answers depending on who is asking:

| question | answer | who may ask |
|---|---|---|
| which namespace is **this runtime** the server for? | `runtimeNamespace()` (`infra/runtime-identity`) | a gateway-spawned backend, or an exec child its spawner told |
| which namespace does **this checkout** own? | `checkoutNamespace(root)` | the CLI, checks |
| which deploy did this checkout **publish**? | `resolveCheckoutDeploy(root)` | anything driving the deployed app |

The first does not live in this plugin at all, and that split is the point. It is
declared once, at a process's entry point, from the `--namespace` its spawner
passed — so a process that was told nothing has no answer and asking THROWS. It
used to ride in an environment variable, which every agent pane inherited from
main's backend: inside a worktree it answered `singularity`, so a CLI or an e2e
script that read it acted on MAIN's deploy while reporting success. See
[`runtime-identity`](../runtime-identity/CLAUDE.md).

The third is a READ, not a derivation, and that is what makes it safe.
`./singularity build` records the checkout that published a namespace in that
namespace's own `spec.json` — the `server` field, an absolute path ending in
`SERVER_CORE_RELATIVE` — and `deploysForCheckout(root)` matches every registered
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

## The data root is a registry, not a string

Everything under `~/.singularity/` is a **declared directory with an owner**.
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

checkCache.ensure();                 // mkdir -p, returns the path
checkCache.file("abc123.json");      // a path INSIDE it
```

### The kinds are a closed set

`apps` · `worktrees` · `services` · `state` · `cache` · `locks` · `logs` ·
`deprecated`.

A kind is a **reclaim class** — the answer to "may I delete this whole subtree?"
that a size listing can never give you. `cache/` and `locks/` are reclaimable
wholesale; `state/` and `apps/` hold the only copy of something. Adding a kind is
a reviewed edit to `DATA_DIR_KINDS`, and that friction is the point.

### The root itself is unjoinable

`dataRoot()` returns the root, and its **only** legitimate use is handing that
root to a child process as its `SINGULARITY_DIR` (the gateway spawn, a release
launch, a remote deploy's env line) — or reporting it to a human.
`join(dataRoot(), …)` is exactly what `defineDataDir` exists to replace: a
joined root is an undeclared directory, which is the failure mode the registry
is here to make impossible.

`paths:data-root-not-joined` enforces it: no `join`/`resolve`/`` `${…}/` `` of
`dataRoot()`, and no **read** of `process.env.SINGULARITY_DIR` outside a
four-entry allowlist (a raw env read is a second derivation of the root).
**Writing** that var — `=`, `??=`, an `env: {…}` key — is the handoff to a child
and is never flagged; `*.test.ts` is exempt, since a test owning its own root is
correct.

To name a declared location under a root that is **not** this process's own (a
preview's `/tmp` data dir, a fresh install's), use `relativeToDataRoot(dir, …)`.
It takes a `DataDir`, so the answer comes from the declaration.

`dataRoot()` is a **function**, and `DataDir.path` is a **getter** — never a
value frozen at module eval. `SINGULARITY_DIR` is env-overridable and the release
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
   `.file(…)` / `.ensure()`. Never re-derive the path.
3. Run `./singularity build`, then `./singularity check paths:no-undeclared-data-dirs`.

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
returns `{ path, file(…), ensure() }` — one lowercase segment, NOT registered.

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
`SINGULARITY_WORKTREE=singularity`, so a worktree's CLI, tests and hooks read as
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
  per-worktree op can assert a root that runs ahead of its own branch. Run it
  with a standalone `./singularity check`. A namespace that has never booted
  publishes nothing, so its dirs read as undeclared until it does.

`paths:no-undeclared-data-dirs` reads the REAL root and fails on any top-level
entry that is neither declared nor grandfathered. Grandfathering is driven by
one `LEGACY_LAYOUT` table (`core/internal/legacy-layout.ts`), shared by the
check and by the one-off
`./singularity run plugins/infra/plugins/paths/scripts/migrate-data-layout.ts`
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

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Canonical machine paths, plus the boot-time publication of this namespace's declared data-dir set so an audit running in another checkout can tell one of this branch's directories from an orphan.
- Core:
  - Uses:
    - `framework/tooling/collected-dir.defineCollectedDir`
    - `infra/namespace.asNamespace`
    - `infra/namespace.CheckoutRef`
    - `infra/namespace.isNamespace`
    - `infra/namespace.MAIN_COMPOSITION_ID`
    - `infra/namespace.MAIN_WORKTREE_NAME`
    - `infra/namespace.Namespace`
    - `infra/namespace.namespaceFor`
    - `infra/runtime-identity.isMain`
    - `infra/runtime-identity.runtimeNamespace`
    - `infra/spawn.getMainRepoRoot`
  - Exports (types):
    - `AppIdentity`
    - `CheckoutDeploy`
    - `CheckoutDeployResolution`
    - `CheckoutOwnerRead`
    - `DataDir`
    - `DataDirArea`
    - `DataDirInput`
    - `DataDirKind`
    - `DataDirRef`
    - `DataDirSpec`
    - `LegacyMove`
    - `MigrationStep`
    - `MovedFrom`
    - `ReclaimPolicy`
    - `ReleaseIdentity`
  - Exports (values):
    - `actAsCheckoutNamespace`
    - `BACKUPS_DIR`
    - `CHECK_ARTIFACTS_RETENTION`
    - `checkoutNamespace`
    - `checkoutRef`
    - `checkoutWorktreeName`
    - `CLAUDE_DIR`
    - `CLAUDE_PROJECTS_DIR`
    - `CLAUDE_SESSIONS_DIR`
    - `CLAUDE_USER_CONFIG`
    - `DATA_DIR_KINDS`
    - `dataRoot`
    - `defineAppDataDir`
    - `defineDataDir`
    - `deploysForCheckout`
    - `getDataDirs`
    - `HOME_DIR`
    - `isHostSingleton`
    - `isRelease`
    - `LEGACY_LAYOUT`
    - `listWorktreeDirs`
    - `planMigration`
    - `PLUGINS_DIR`
    - `pruneWorktreeCheckArtifacts`
    - `pruneWorktreeTestArtifacts`
    - `readCheckoutOwner`
    - `relativeToDataRoot`
    - `releaseIdentity`
    - `REPO_ROOT`
    - `repoConfigDir`
    - `resolveCheckoutDeploy`
    - `SERVER_CORE_RELATIVE`
    - `setReleaseIdentity`
    - `toolchainPin`
    - `WORKTREE_SPEC_FILE`
    - `worktreeArtifacts`
    - `worktreeDataDir`
    - `worktreesDir`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by: 56 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `debug` ×10
    - `infra` ×8
    - `build` ×7
    - `conversations` ×5
    - `backup` ×4
    - `framework` ×4
    - `primitives` ×3
    - `release` ×3
    - `code-explorer` ×2
    - `plugin-meta` ×2
    - `stats` ×2
    - `apps/deploy/deployments`
    - `config_v2`
    - `reports/outbox`
    - `review/plugin-changes`
    - `tasks`
    - `toolchain`
- Exemptions:
  - Exempts itself from:
    - `paths:no-hardcoded-paths` — `check/index.ts`, `core/internal/paths.ts`, `server/internal/bins.ts` (sanctioned)
    - `paths:no-inlined-worktree-artifacts` — `.` (sanctioned)
    - `paths:data-root-not-joined` — `.` (sanctioned)
- Server:
  - Exports (types):
    - `AppIdentity`
    - `ClaudeBinLookup`
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
    - `BACKUPS_DIR`
    - `BUILD_ARTIFACTS_RETENTION`
    - `CHECK_ARTIFACTS_RETENTION`
    - `checkoutNamespace`
    - `checkoutRef`
    - `checkoutWorktreeName`
    - `CLAUDE_CANDIDATES`
    - `CLAUDE_DIR`
    - `CLAUDE_PROJECTS_DIR`
    - `CLAUDE_SESSIONS_DIR`
    - `DATA_DIR_KINDS`
    - `dataRoot`
    - `defineAppDataDir`
    - `defineDataDir`
    - `getDataDirs`
    - `GIT`
    - `HOME_DIR`
    - `isHostSingleton`
    - `isRelease`
    - `listWorktreeDirs`
    - `listWorktreeDirsAsync`
    - `PGREP`
    - `PLUGINS_DIR`
    - `pruneWorktreeBuildArtifacts`
    - `pruneWorktreeCheckArtifacts`
    - `pruneWorktreeRunArtifacts`
    - `PS`
    - `publishDataDirsManifest`
    - `relativeToDataRoot`
    - `releaseIdentity`
    - `REPO_ROOT`
    - `repoConfigDir`
    - `resolveClaudeBin`
    - `RUN_ARTIFACTS_RETENTION`
    - `RUN_TERMINAL_SUFFIX`
    - `RUN_TRANSCRIPT_SUFFIX`
    - `SERVER_CORE_RELATIVE`
    - `setReleaseIdentity`
    - `TMUX`
    - `WEB_CORE_RELATIVE`
    - `webDistDir`
    - `worktreeArtifacts`
    - `worktreeDataDir`
    - `worktreesDir`
- Sub-plugins:
  - **`display`** — The human-facing spelling of the singularity data dirs (the `~/…` form a message, an empty state, or an agent prompt writes). Web-safe by construction: string literals only, no node:* and no…

<!-- AUTOGENERATED:END -->
