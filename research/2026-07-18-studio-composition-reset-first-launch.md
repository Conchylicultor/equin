# Reset a served composition to its first-launch state

## Context

Auto-served compositions are live apps at `http://<id>.localhost:9000`, composed
from the plugin marketplace and served on every main build (see
`research/2026-07-17-global-composition-auto-serve.md`). Today there is no way to
see what a *brand-new* user experiences when they first open one of these apps —
after any manual poking, the DB has rows and the config has been edited away from
its shipped defaults.

This feature adds a **"Reset to first-launch"** action in the composition detail
pane's **Auto build & serve** section: it wipes that one composition's data back
to exactly the state `compose-serve` provisions on a fresh serve, so an author can
test the genuine first-launch UX on demand.

**Hard requirement: main is never touched, and each composition is fully
isolated.** The design leans entirely on the existing per-namespace isolation
(DB name = config dir name = composition id) plus multiple identity-provenance
guards; there is no way for this path to reach main's `singularity` DB or config.

### Scope (decided)

- **In scope:** the composition's Postgres database `<id>` and its config dir
  `~/.singularity/config/<id>/`. Both are named by the composition id, so a reset
  is provably confined to that one namespace.
- **Out of scope (deliberately ignored):** central secrets / auth tokens. These
  live in one global encrypted store (`~/.singularity/secrets.json.enc`) shared by
  every namespace by the single-instance-per-user architecture
  (`research/2026-07-02-global-adr-single-instance-per-user.md`) — they carry no
  per-composition dimension and are not part of this reset. Documented, not
  worked around.

## Why this shape

A served composition (verified in `compose-serve.ts`):
- has its **own DB** `<id>` — created empty by `ensureDatabase(id)`, *never a fork
  of main's data*; the backend's boot migrator builds the schema on first spawn.
- has its **own config dir** `~/.singularity/config/<id>/`, materialized by
  `propagateConfigToUser({ root, worktreeName: id, singularityDir })` (git-layer
  defaults, not code defaults).
- is marked by a `composition.json` provenance file under
  `~/.singularity/worktrees/<id>/`, written *before* anything else touches the
  namespace. `compose-serve` refuses to serve a name that collides with a real git
  worktree/branch. **That marker is the decisive "this is a compose-serve
  namespace, not main and not a real worktree" signal.**

So the faithful reset is a **narrower `reapAttempt`** (cf.
`plugins/debug/plugins/worktree-cleanup/server/internal/reap.ts`): keep the spec +
dist + code (stays served), wipe only DB + config, then restart:

1. Drop Zero replication artifacts, then `dropDatabase(id)`, then
   `ensureDatabase(id)` (fresh empty DB; backend re-migrates on boot).
2. `rm -rf ~/.singularity/config/<id>` then re-run `propagateConfigToUser(...)`
   (a bare delete would fall back to *code* defaults — not a genuine first-launch;
   re-propagating restores the shipped git-layer defaults compose-serve installs).
3. `POST http://localhost:9000/gateway/worktrees/<id>/restart` to reboot the
   backend against the emptied DB.

## Safety guards (all must pass, else throw `CompositionResetError` — fail loudly)

1. `assertServableCompositionNamespace(id)` — rejects the reserved namespaces
   (`RESERVED_COMPOSITION_NAMESPACES = {central, singularity, main}`) and enforces
   a valid name. **This is the explicit "never main/central" gate.**
2. `hasCompositionMarker(id)` — `~/.singularity/worktrees/<id>/composition.json`
   must exist (proves compose-serve owns this namespace).
3. `namespaceCollision(id, probeNamespace(root, id)) === null` — no git worktree
   dir, no git branch, no marker-less spec dir of that name.
4. `id` is currently `autoBuild: true` in **main's** resolved config (belt-and-
   suspenders; deactivation sweeps the marker, so 2 already implies this).

## Single-source the guard (structural, not a duplicate)

The provenance/collision logic (`namespaceCollision`, `probeNamespace`,
`NamespaceProbe`, the `composition.json` marker constant + reader, `branchExists`)
currently lives **inside the CLI bin file** `compose-serve.ts` (lines 52–165) and
is not importable from a runtime server plugin. Duplicating a *safety-critical*
guard risks silent drift (someone changes the marker name in one place). Extract it
once into `infra/worktree/server` (which already owns the `worktrees/<name>` spec
layout) and have both callers consume it.

## Files

### New
- `plugins/infra/plugins/worktree/server/internal/composition-namespace.ts`
  — moved verbatim from `compose-serve.ts`: `COMPOSITION_MARKER_FILE`,
  `interface CompositionMarker`, `interface NamespaceProbe`,
  `readCompositionMarker(id)`, `hasCompositionMarker(id)`,
  `probeNamespace(root, id)`, `namespaceCollision(id, probe)`.
- `plugins/apps/plugins/studio/plugins/compositions/plugins/auto-serve/shared/endpoints.ts`
  — `resetCompositionData = defineEndpoint({ route: "POST /api/studio/compositions/auto-serve/reset", body: { id }, response: { ok } })`.
- `.../auto-serve/server/internal/reset.ts` — `resetCompositionData(id)`: the
  guarded recipe above + a tolerant `restartNamespace(id)` (~15-line fetch
  mirroring compose-serve's: 404 = not running, `TypeError`/`DOMException` =
  gateway down, else rethrow). Does **not** call `getAdminPool().end()` (that is a
  CLI-exit concern; the server pool is long-lived).
- `.../auto-serve/server/index.ts` — `implement(resetCompositionData, ...)`,
  default-export `ServerPluginDefinition`.

### Modified
- `plugins/infra/plugins/worktree/server/index.ts` — re-export the new helpers.
- `plugins/framework/plugins/cli/bin/commands/internal/compose-serve.ts` — import
  the marker/collision helpers from `@plugins/infra/plugins/worktree/server`,
  delete the local copies. `writeMarker` (stamps `buildId`/`builtAt`) stays but
  builds the shared `CompositionMarker` type. Pure relocation, no behavior change.
- `.../auto-serve/web/components/auto-serve-section.tsx` — inside the existing
  `item.autoBuild` branch, add a destructive "Reset to first-launch" control that
  opens a confirm dialog and calls the endpoint (see below).
- `.../auto-serve/CLAUDE.md` — document reset + the out-of-scope central-secrets
  note.

## Verified barrels (all boundary-legal from a server runtime)

| Symbol | Barrel |
|---|---|
| `dropDatabase`, `ensureDatabase`, `databaseExists` | `@plugins/database/plugins/admin/server` |
| `dropZeroReplicationArtifacts` | `@plugins/database/plugins/zero/plugins/cache-service/server` |
| `propagateConfigToUser`, `assertServableCompositionNamespace`, `RESERVED_COMPOSITION_NAMESPACES`, `readEffectiveConfigFromDisk` | `@plugins/framework/plugins/tooling/plugins/codegen/core` |
| `SINGULARITY_DIR`, `MAIN_WORKTREE_NAME` | `@plugins/infra/plugins/paths/server` |
| `ensureMainWorktreeRoot`, `writeWorktreeSpec`, + new namespace helpers | `@plugins/infra/plugins/worktree/server` |
| `compositionsConfig`, `manifestItemToManifest`, `CompositionManifestItem` | `@plugins/plugin-meta/plugins/composition/core` |
| `asPath`, `asPluginId` | `@plugins/framework/plugins/plugin-id/core` |
| `defineEndpoint` / `implement` / `useEndpointMutation` | `@plugins/infra/plugins/endpoints/{core,server,web}` |
| `openDialog` | `@plugins/primitives/plugins/imperative-dialog/web` |

Gateway restart has no shared helper (raw `fetch` in 3 places) — reproduce the
tolerant version locally rather than over-extract for one caller.

## Web wiring

The section already has `{ id }` and `item.autoBuild`, so gating is trivial. Add,
only when `item.autoBuild`:

```tsx
const reset = useEndpointMutation(resetCompositionData);
// destructive Button/ToggleChip:
onClick={() =>
  openDialog((close) => (
    <ConfirmReset
      host={host}
      onCancel={close}
      onConfirm={async () => { await reset.mutateAsync({ id: item.id }); close(); }}
    />
  ))
}
```

Confirm copy states main is untouched, e.g.: *"Reset {host} to first-launch? This
wipes this composition's database and config so you see exactly what a new user
gets. The main app's data (the 'singularity' database and its config) is not
touched."*

## Which backend serves it

Any backend — the endpoint touches only host-global resources
(`~/.singularity/config/<id>`, the shared PG cluster admin pool, the gateway on
`localhost:9000`). The `autoBuild` guard reads **main's** on-disk config
(`worktreeName: MAIN_WORKTREE_NAME`) regardless of the executing backend, matching
compose-serve's main-authoritative model.

## Verification (end-to-end)

1. Studio → Compositions → pick a test composition, toggle **Serve** on, run
   `./equin build`. Confirm `http://<id>.localhost:9000` boots and DB `<id>`
   + config `~/.singularity/config/<id>` + the `composition.json` marker exist.
2. Mutate: `INSERT` a row into DB `<id>` (via `mcp__singularity__query_db` against
   `database: "<id>"`) and change a config value in the served app's Settings.
3. Baseline main: `SELECT count(*)` on a table in DB `singularity`; note a file
   under `~/.singularity/config/singularity/`.
4. Click **Reset to first-launch**, confirm.
5. Assert: DB `<id>` exists but is freshly re-migrated (inserted row gone); config
   `~/.singularity/config/<id>` back to propagated git defaults (changed field
   reverted, dir repopulated not missing); the served app shows genuine
   first-launch; **main unchanged** (row count + config identical to step 3).
6. Negative guards (each throws, nothing touched): `id: "singularity"` (reserved);
   an `id` whose dir lacks `composition.json`; an `autoBuild:false` id.
7. `./equin build` and `./equin check` (boundaries + type-check) clean.
