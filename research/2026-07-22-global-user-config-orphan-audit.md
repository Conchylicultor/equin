# User-layer config orphan audit (read-only)

## Context

`./equin build` prunes orphaned config files in the **git `config/` layer**
(`pruneOrphanedConfigFiles` in
`plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts:399`,
guarded by the `config-origins-in-sync` check). But the **user layer**
(`~/.singularity/config/<worktree>/`) has **no equivalent sweep**:
`propagateConfigToUser` (`config-origin-gen.ts:542`) only writes/updates files for
*live* descriptors and self-heals a couple of narrow scoped cases — it never removes
a base `.origin.jsonc`/`.jsonc` whose descriptor was removed, renamed, or re-scoped
to a different `pluginId` (which moves its hierarchy path).

Result: dead files accumulate. Confirmed live in main's dir —
`~/.singularity/config/singularity/primitives/data-view/` holds stale
`config_v2.settings.nav.*`, `prototypes.gallery.*`, `view-state.*`, `tasks-recent.*`,
and ~10 more `.origin.jsonc` leftovers (the DataView `views` configs now register
under each consumer's own tree, e.g. `config_v2/settings/`; `view-state` is not a
descriptor at all). They shadow nothing and make the dir misleading to inspect.

**Why we audit instead of prune.** Git-layer files are version-controlled — pruning
is recoverable. User-layer files are **not**; a wrong deletion is permanent data
loss. And orphans split into two risk classes:

- **noise** — an orphaned `.origin.jsonc` (± `.ancestor.jsonc`) with *no* sibling
  override: a stale default snapshot, zero user data.
- **stranded-data** — an orphaned base `.jsonc` (or `@app/<id>/…` scoped) override:
  a real **user customization** that silently stopped applying when its descriptor
  moved.

This plan ships a **read-only audit** that flags and classifies orphans. No deletion
this round (deliberately — "audit those first"). Safe gated cleanup is a separate
later plan (see Follow-ups).

## Decisions (confirmed with user)

- **Surface:** a Debug pane (sibling to `debug/worktree-cleanup`, which is exactly
  "audit stale on-disk state before removal"). Not the config settings DataView (that
  nav is fully client-side over *live* registrations; injecting descriptor-less orphan
  rows needs a discriminated row-kind union + a new raw-file detail pane — surgery on
  a load-bearing component for no gain over a Debug pane).
- **Scope:** current worktree only. Each worktree runs its own server (one-instance-
  per-user ADR); it audits its own `CONFIG_DIR` against its own live registry — always
  correct. Auditing another worktree's dir against this server's descriptor set would
  false-positive across branches.
- **Read-only.** No delete action. A `./equin check` was rejected: checks are
  binary pass/fail with no "warn" level, and since we intentionally don't prune it
  would stay permanently red with no auto-fix.

## Design

### 1. Single-source the ownership function (structural fix)

`configFileOwner(relPath)` (the pure `.origin.jsonc`/`.jsonc`/`@app/<id>` →
`{hier,name}` mapper, `config-origin-gen.ts:347`) is the exact logic the audit needs.
Today it's private to codegen. Move it to **`plugins/config_v2/core`** (pure string
logic; `APP_SCOPE_DIR` already lives there) and export it. Update
`config-origin-gen.ts` to import it from `@plugins/config_v2/core` instead of its
local copy. The DAG edge codegen → `config_v2/core` already exists (codegen uses
`config_v2.APP_SCOPE_DIR`, `computeHash`, etc.), so direction is preserved. Now one
ownership function backs both the git-layer prune and the user-layer audit — they
can't drift.

### 2. Audit function — `plugins/config_v2/server`

Add `auditUserConfigOrphans(): OrphanReport` (export from the server barrel;
`OrphanReport`/`OrphanEntry` types in `config_v2/core`). It:

1. Builds the live `Map<hier, Set<name>>` from `getAllDescriptors()`
   (`resource.ts:425`, returns `[storePath, descriptor][]`) via `configFileOwner`.
2. Walks `CONFIG_DIR` (`config_v2/server/internal/config-dir.ts:11`) for every
   `.jsonc`/`.origin.jsonc`/`.ancestor.jsonc` (a small server-side directory walk —
   don't import codegen's build-time `walkJsoncFiles`; keep the server → build-tooling
   edge out).
3. For each on-disk file, computes its owner; a file whose `(hier,name)` isn't in the
   live set is an orphan. Groups orphans by `(hier,name)`.
4. Classifies each group:
   - `riskClass`: **stranded-data** if it has a base `.jsonc` or any `@app/<id>/…`
     override, else **noise** (origin/ancestor only).
   - `reason`: **relocated** if some live descriptor shares the same `name` (distinctive
     for the reported case — DataView ids like `config_v2.settings.nav` — carries
     `relocatedToHier`), else **removed**. Heuristic (name-collision on generic
     `"config"` names would over-report "relocated"); it's an audit hint, labelled
     "likely", not an action trigger.
5. Returns `OrphanEntry[]`: `{ storeKey: "<hier>/<name>", hier, name, riskClass,
   reason, relocatedToHier?, files: [{ relPath, role, bytes, mtimeMs }],
   totalBytes, newestMtimeMs }`.

No live-state resource — orphans change only on build/descriptor removal (rare), and a
full-dir scan is not a membership-bounded working set. On-demand endpoint + manual
refresh (mirrors `worktree-cleanup`'s `handle-list`), no polling.

### 3. Debug pane — `plugins/debug/plugins/config-orphans` (new)

Mirror `debug/worktree-cleanup` structure byte-for-byte:

- `shared/endpoints.ts` — `defineEndpoint` `GET /api/debug/config-orphans` → `OrphanReport`.
- `server/` — the handler calls `config_v2`'s `auditUserConfigOrphans()`. (Domain logic
  stays in config_v2, which owns config layout; the debug plugin is pure presentation.)
- `web/` — the pane + `DebugApp.Sidebar` registration (`Pane.Register`, `sidebarNavItem`,
  `openPane`, icon e.g. `MdRuleFolder`), copied from `worktree-cleanup/web/index.ts`.

The orphan list is a homogeneous set of domain records → render as a **DataView**
(`views: ["table"]`), per the data-view guardrail — search/filter/sort come free:
- fields: **Path** (`storeKey`, primary) · **Risk** (enum noise/stranded-data) ·
  **Reason** (enum relocated/removed, showing `relocatedToHier`) · **Files** (count) ·
  **Size** · **Modified** (`RelativeTime` on `newestMtimeMs`).
- Filtering to `Risk = stranded-data` surfaces exactly the data-bearing (dangerous)
  orphans. Read-only — no row delete action. Per-row expansion to list the underlying
  file paths is fine; raw-content viewing is optional and can be deferred.

## Critical files

- `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts` —
  move `configFileOwner` out; import it from `@plugins/config_v2/core`.
- `plugins/config_v2/core/` — new `configFileOwner` home + `OrphanReport`/`OrphanEntry`
  types; barrel exports.
- `plugins/config_v2/server/` — `auditUserConfigOrphans()` (uses `CONFIG_DIR`,
  `getAllDescriptors`, `configFileOwner`); barrel export. `CONFIG_DIR` itself is in
  `server/internal/config-dir.ts` — reuse in-plugin (no need to export it).
- `plugins/debug/plugins/config-orphans/{shared,server,web}/` — new plugin, modeled on
  `plugins/debug/plugins/worktree-cleanup/`.

## Verification

1. `./equin build`, then open **Debug → Config Orphans** at
   `http://equin.localhost:9000` (main, where the reported leftovers live).
   Expect: `config_v2.settings.nav` + `prototypes.gallery` classified
   **stranded-data / relocated** (they have base `.jsonc` overrides); `view-state`,
   `tasks-recent` classified **noise / removed**. The two *live*
   `primitives.data-view.row-order` / `.field-extension` files must **not** appear
   (their descriptors are live at that hier).
2. `bun test plugins/config_v2/server/…orphan-audit.test.ts` — pure unit test over a
   temp `CONFIG_DIR` fixture: seed an origin-only file, a base override, an `@app`
   scoped override, and a file matching a live descriptor; assert the live file is
   excluded and each orphan gets the right `riskClass`/`reason`.
3. `./equin check config-origins-in-sync` still passes (we didn't touch git-layer
   files or origin rendering — only relocated `configFileOwner`'s definition).

## Follow-ups (out of scope, separate plans)

- **Safe gated cleanup:** a later phase can add per-item deletion — one-click for the
  **noise** class (zero user data), explicit confirmation for **stranded-data**.
- **Structural symmetry:** longer-term, `propagateConfigToUser` could prune the
  **noise** class during build the same way the git layer is pruned (never touching
  stranded-data), eliminating the noise class at the source. Deferred per "audit first".
- **Stranded overrides are a real latent bug:** a moved `pluginId` silently abandons a
  user's existing override (their setting stops applying, un-migrated). The audit
  surfaces these so a human can re-apply them; a migration path is a separate question.
