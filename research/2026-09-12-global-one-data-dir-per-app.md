# One data dir per app: `~/.singularity/apps/<app>/`

## Context

The intended rule: **each app owns exactly one data dir, `apps/<app>/`, and all of that app's
durable content (including its sub-plugins') lives inside it.** Nothing states or enforces this today:

- Anyone can call `defineDataDir({ kind: "apps", name: <anything>, owner })`
  (`plugins/infra/plugins/paths/core/internal/data-dir.ts`). The name has no tie to an app, and
  `owner` is free text that nothing validates.
- `paths:no-undeclared-data-dirs` only checks that each `apps/<x>` on disk is *declared*. It is also
  host-scoped, so it never runs during a build.

The miss that prompted this: while designing prototype version history, an agent proposed a second
dir `apps/prototype-history` beside `apps/prototypes`. Nothing flagged it; the user caught it in
review. The history landed at `apps/prototypes/_history/` in the end (commit `b9d0d4d3e`).

**Audit of today's `apps/*`:**

| Dir | Declared by | App? | Outcome |
|---|---|---|---|
| `apps/prototypes` | `apps/prototypes/files` (a sub-plugin) | yes | stays; declaration moves to the app root |
| `apps/sonata` | `apps/sonata/sources/midi/folders` (4 levels deep) | yes | stays; declaration moves to the app root (its own docblock asks for this) |
| `apps/wallpaper` | `apps-core/surface/floating/wallpaper` | no | moves to `apps/desktop/wallpaper/`. `apps-core` is the **desktop** meta-app (user decision) |
| `apps/attachments` | `infra/attachments` | no (shared by mail, pages, tasks) | moves to `state/attachments` (user decision) |

No app plugin puts durable data under `state/` today. All `state/*` owners are infra.

## Design

### 1. API: an `apps/*` dir can only be spelled from an app identity (type error + loud throw)

In `paths/core/internal/data-dir.ts`:

- `defineDataDir`'s input takes `kind: Exclude<DataDirKind, "apps">`. So `defineDataDir({ kind: "apps", … })`
  is a **tsc error**. The stored `DataDirSpec` keeps the full `DataDirKind`, so the registry,
  manifest and audit are unchanged.
- New `defineAppDataDir(app: { readonly id: string }, { owner, description, movedFrom? })`:
  - The name is `app.id`; there is no `name` parameter.
  - `reclaim` is fixed to `never`: an app dir holds its only copy. App caches still go to `cache/`.
  - The `app` param is structural (an `AppRef` satisfies it). This avoids a new `infra/paths → primitives/pane` edge; the check in §3 is what makes the id honest.
  - A second call for the same app **throws with an app-specific message**: *"app `prototypes` already owns its data dir (`apps/prototypes`, declared by `apps/prototypes`). An app owns exactly one data dir; put `<description>` inside it with `prototypesDir.subdir("<name>")`."*
    That is exactly what the prototype-history agent would have hit.
- New `DataDir.subdir(name)` returns a `{ path, file(), ensure() }` handle for an area inside the dir.
  It is not registered, and the name must be one segment (same regex as a data-dir name). This is how a sub-plugin gets its own area in the app's dir.

### 2. Where an app's dir is declared: the app root

- Regular app: `plugins/apps/plugins/<id>/data-dirs/index.ts` (the app's umbrella folder), passing the
  `AppRef` from `@plugins/apps/plugins/<id>/plugins/shell/core`. Codegen already collects `data-dirs/` on umbrella nodes; `plugins/debug/data-dirs/` is the precedent.
- The desktop meta-app: `plugins/apps-core/data-dirs/index.ts`. It declares `apps/desktop` from a new
  `plugins/apps-core/core/app.ts` → `export const desktopApp = { id: "desktop" } as const`.
- Sub-plugins import `@plugins/apps/plugins/<id>/data-dirs` (legal from `server`, `shared`, `cli`, `e2e`, `bin`).
  Constraint, stated in the docblock: `shell/core` must never import the app's data dir. The root's `data-dirs` imports `shell/core`, so that import would close a cycle.
- The closed meta-app table lives in `paths/core`: `META_APP_ROOTS = { desktop: "apps-core" }`. Adding a
  meta-app is a reviewed edit, the same principle as `DATA_DIR_KINDS`.

### 3. New repo-scope check `paths:app-data-dirs` (runs in build, check and push)

It lives in `plugins/infra/plugins/paths/check/index.ts`. It loads each generated `data-dirs` entry itself, so every loaded `DataDir` is paired with the entry's real `pluginPath`. The rules live in a pure function, `evaluateDataDirDeclarations(pairs, metaAppRoots)`, which gets unit tests.

- **A. App dirs belong to their app.** An `apps/<n>` item must be declared by `apps/plugins/<n>`, or by
  `META_APP_ROOTS[n]` for a meta-app. This one rule ties the name to a real app folder. It also blocks a hand-made `{ id: "prototype-history" }` literal and an app declaring a second dir under another name.
- **B. An app's durable data lives in its app dir.** A declaration from inside an app's subtree
  (`apps/plugins/<x>/**`, or a meta-app root's subtree) that has `reclaim: never` and is not `kind: "apps"` fails.
  The message: *"durable data of app `x` belongs in `apps/x` — use `xDir.subdir(…)`"*. This closes the
  `state/prototype-history` escape route. Reclaimable kinds (`cache`, `locks`, `logs`) stay allowed, e.g. `cache/prototypes-thumbnails`.
- **C. `owner` is not free text.** `spec.owner` must equal the declarer's path with `/plugins/` segments
  removed. All 27 current declarations already follow this convention, so nothing changes today.
- **D. Declarations are visible to the registry.** A `defineDataDir(` / `defineAppDataDir(` call site
  outside a `data-dirs/index.ts` fails (tests and the `paths` plugin itself are exempt). None exist today.

Precedence: A is the "impossible" part, backed by the type change. B–D are the lint layer around it.

### 4. Moving a declared dir: `movedFrom` (a generic primitive, not a one-off script)

`LEGACY_LAYOUT` is a self-liquidating, top-level-only table ("nothing may be added"), and its
script refuses to run while a gateway is alive. So instead, a declaration records where it used to be:
`movedFrom?: { from: DataDirRef; to?: string }[]`, where `to` is a sub-path inside the dir (default: the dir itself).

- `state/attachments`: `movedFrom: [{ from: "apps/attachments" }]`
- `apps/desktop`: `movedFrom: [{ from: "apps/wallpaper", to: "wallpaper" }]`

Resolution, in `makeDataDir`'s path resolution (so no consumer can read the new spot before the move):

- **Settled**: `from` is absent or a symlink. Resolve to the new location, and memoize per data root.
- **Pending**: `from` is a real dir and the destination is absent.
  - In a **host-singleton process** (`isHostSingleton()`: the main backend, or a release backend on its own root), perform the move once. `mkdir -p` the parent, `rename(from, dest)` (atomic), then plant a relative symlink at `from` so older checkouts keep reading and writing the same bytes. An `ENOENT`/`EEXIST` from a concurrent mover means another process won; re-inspect.
  - In **any other process** (worktree backends, CLI, tests), resolve to the **old** location. Building this branch therefore never touches the shared root; the move happens when main restarts after the push.
- **Conflict**: `from` is a real dir **and** the destination exists. Throw loudly. That is a split copy, which needs a human.

Audit check (`paths:no-undeclared-data-dirs`) changes:

- Rule 3 (entries inside a kind dir) accepts a `movedFrom.from` entry that is absent, a symlink to its destination, or pending. It rejects a conflict. This filtering happens *before* the foreign-manifest attribution.
- `legacy-layout.test.ts` ("every `to` names a declared dir") also accepts a `to` that some declaration lists as a `movedFrom.from`. The old top-level shims (`attachments → apps/attachments`, `wallpaper → apps/wallpaper`) keep their rows. They now resolve through two hops, and the check reads only one hop (`readlinkSync`), so they still verify.

## Changes (file map)

- `plugins/infra/plugins/paths/core/internal/data-dir.ts`: input type narrowing, `defineAppDataDir`,
  `subdir`, `movedFrom` resolution/move, `META_APP_ROOTS`, updated `apps` kind docblock ("one dir per app"). Export
  the new names from `paths/core/index.ts`.
- `plugins/infra/plugins/paths/check/index.ts`: the new `paths:app-data-dirs` check, plus the rule 3 `movedFrom` acceptance.
- `plugins/infra/plugins/paths/core/internal/legacy-layout.test.ts`: accept `movedFrom` destinations.
- **prototypes**: new `plugins/apps/plugins/prototypes/data-dirs/index.ts` (`prototypesDir = defineAppDataDir(prototypesApp, …)`).
  Delete `files/data-dirs/`, and delete the `export { prototypesDir }` line in `files/server/index.ts` (it would become an illegal cross-plugin re-export).
  Repoint about 15 importers: files' `server`/`shared`/`cli`/`e2e`, `thumbnails/server`, `backup/sources/prototypes`, and `guards/bin/guard.ts`.
- **sonata**: new `plugins/apps/plugins/sonata/data-dirs/index.ts`. Delete `midi/folders/data-dirs/`, and repoint `reconcile.ts`.
- **desktop**: `plugins/apps-core/core/app.ts` (`desktopApp`), `plugins/apps-core/data-dirs/index.ts` (`desktopDir` with
  the wallpaper `movedFrom`). Delete `wallpaper/data-dirs/`. `wallpaper/server/internal/store.ts` uses `desktopDir.subdir("wallpaper")`.
- **attachments**: `plugins/infra/plugins/attachments/data-dirs/index.ts` becomes `kind: "state"` with `movedFrom`. No importer changes.
- Docs: `plugins/infra/plugins/paths/CLAUDE.md` (the one-dir-per-app rule, `defineAppDataDir`, `subdir`, `movedFrom`,
  the new check), `.claude/skills/create-app/SKILL.md` (an app's files go in its one data dir, at the app root), and
  `plugins/apps-core/CLAUDE.md` (the desktop meta-app identity).

Trade-off: app-dir `owner`s become the app root (`apps/prototypes`) rather than the sub-plugin that
manages the files day to day. That is intended, since the app owns the dir.

## Verification

1. Unit tests (`./equin test plugins/infra/plugins/paths`):
   - `data-dir.test.ts`:
     - `defineAppDataDir` derives the name, and a second call throws the app message.
     - `// @ts-expect-error` on `defineDataDir({ kind: "apps" })`.
     - `subdir` works.
     - `movedFrom` on a temp `SINGULARITY_DIR`: fresh root resolves to new; pending + non-singleton resolves to old and moves nothing; pending + singleton (env `SINGULARITY_WORKTREE=singularity`) moves and leaves a symlink, and a second call is a no-op; conflict throws; a sub-path move (`to: "wallpaper"`) works.
   - A pure-rule test for `evaluateDataDirDeclarations`, one case per rule A–D, on hand-built literals (the `legacy-layout.test.ts` style).
2. Negative checks in scratch (reverted afterwards):
   - `defineDataDir({ kind: "apps", name: "prototype-history" })` fails tsc.
   - `defineAppDataDir(prototypesApp)` in `thumbnails/data-dirs` throws, and fails `paths:app-data-dirs`.
   - `defineDataDir({ kind: "state", … reclaim never })` inside an app fails rule B.
3. `./equin build` (background). It covers type-check, plugin-boundaries (no cycles, no re-exports), registry/doc sync and the new check.
4. On the real root after the build: `./equin check paths:no-undeclared-data-dirs` passes and reports the two moves as pending. On `~/.singularity`, `apps/attachments` and `apps/wallpaper` are still real dirs; the worktree build moved nothing.
5. In the worktree app (via `screenshot.ts`): a task attachment image and the floating desktop wallpaper both still render, read through the pending (old) paths.
6. After the user pushes, main restarts and performs the moves. Then `state/attachments` and `apps/desktop/wallpaper` are real dirs, `apps/attachments` and `apps/wallpaper` are symlinks, and the audit passes.

## Follow-ups (not in this change)

- Drop the two `movedFrom` entries and their symlinks once no live checkout's manifest still declares `apps/attachments` / `apps/wallpaper`.
- One app dir per app makes a generic "back up every `apps/*` dir" source possible. Today the wallpaper and sonata dirs have no backup source.
- Sonata's only file is a re-derivable MIDI index, so it could live in `cache/` instead.
