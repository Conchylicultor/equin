# Release bundle: ship config defaults (config_v2 origin + git tier)

**Date:** 2026-07-03
**Category:** global (release CLI + config_v2 + launcher + paths)

## Context

A self-contained release (`./equin release --composition <c> --target tauri|web`)
renders the app surface but drops every config_v2 "default-for-everyone" value at
runtime. The reported symptom: a released Sonata app boots, but its Library pane
shows *"No views configured — author config/<plugin>/sonata.library.jsonc"* instead
of the Cards/All/Longest/Composed view tabs the dev app shows. It is **not**
Sonata-specific — any app's config-backed defaults are absent in a release.

The release pipeline vendors migrations data, natives, web dist, and asset-mirror
into the staged bundle, but **nothing config-related**. The task filed against this
assumed a single root cause; investigation found **two distinct read paths**, each
broken in a release, that must both be fixed:

### Symptom 1 — effective config values (the reported bug)

Effective values are **not** read from `REPO_ROOT/config` at runtime (contrary to the
task's stated root cause). They are read from the **propagated user tier** at
`CONFIG_DIR = SINGULARITY_DIR/config/<worktree>`
(`plugins/config_v2/server/internal/config-dir.ts:11`). That tier is written by
`propagateConfigToUser` (`.../codegen/core/config-origin-gen.ts:500`) during every
`./equin build`, which resolves each `config/<hier>/<name>.origin.jsonc ⊕
<name>.jsonc` (and `@app/<id>` deltas) into `~/.singularity/config/<worktree>/…`.

In a release `SINGULARITY_DIR = <bundle>/data` (`launcher/bin/launch.ts:27`) and the
build's propagation only ever ran against the **ambient** `~/.singularity`, never the
bundle. So `<bundle>/data/config/<worktree>/` is empty and every value falls back to
the field's hardcoded schema default → empty Library views.

### Symptom 2 — raw git-tier display + un-fork check (same root cause, different surface)

Two runtime sites read `REPO_ROOT/config` **directly**:
- `plugins/config_v2/server/internal/registry.ts:648-649` — `getRawFileContent()`
  builds `REPO_ROOT/config/<dir>/<name>.origin.jsonc` + `.jsonc` for the Settings
  "View raw" panel (git origin / git override sections). `readRaw` swallows ENOENT →
  the panel shows empty.
- `plugins/config_v2/server/internal/scope-fork.ts:33` — `gitBacksScope()` does
  `existsSync(REPO_ROOT/config/<hier>/@app/<id>/<name>.jsonc)`; always `false` in a
  release, so un-forking a committed per-app scope drops it entirely instead of
  falling back to the committed scope.

`REPO_ROOT = resolve(import.meta.dir, …)` (`plugins/infra/plugins/paths/core/internal/paths.ts:4`)
resolves into the `bun --compile` binary's virtual FS at runtime, so these paths are
both un-shipped and unreachable.

### Intended outcome

A released app renders its config-backed defaults (Sonata Library shows its view
tabs + toolbar), and the Settings raw-diff view / per-app un-fork behave correctly —
with **zero** changes to how config is read in dev.

## Precedent to mirror

This is the established three-part release-vendoring pattern (already used for
migration SQL, PG/PgBouncer natives, the parcel-watcher `.node`, and asset-mirror
caches):

1. **Stage** — `release.ts` vendors files into `<out>/…`.
2. **Point** — `launch.ts` sets an env var / seeds a dir before anything path-dependent runs.
3. **Read** — the consumer reads env-first, falling back to the dev path.

Two sub-precedents apply, one per symptom:
- **Read-only vendored dir → env override** (migrations): `SINGULARITY_MIGRATIONS_DIR`
  set in `launch.ts:42-46`, read in `migrations/server/internal/runner.ts:19`. Fits
  **symptom 2** (the git-layer tree is read-only at runtime).
- **Mutable dir → seed-copy-if-absent** (asset-mirror): `runAssetMirrorPrewarm` bakes
  `<out>/asset-mirror` at stage (`release.ts:609`), `seedReleaseAssetMirror` copies it
  into the data dir at first launch (`launch.ts:115`, `launcher/server/internal/boot.ts:658`).
  Fits **symptom 1** (CONFIG_DIR is written at runtime by `setConfig`, so it belongs
  in the writable data dir, seeded once).

## Key guarantee (verified)

A release's runtime `SINGULARITY_WORKTREE` **equals the composition name** by
construction — no assumption:
`launch.ts main()` uses `name = manifest.composition` → `bootSelfContainedApp({name})`
(`boot.ts:514`) → `writeWorktreeSpec({name})` (`boot.ts:536`, dir basename = `name`,
`worktree/server/internal/spec.ts:62`) → gateway sets `SINGULARITY_WORKTREE=<dir
basename>` (`gateway/worktree.go:652`). So `CONFIG_DIR = SINGULARITY_DIR/config/<composition>`
at runtime, and seeding into that exact path is deterministic.

## Approach

Ship **two** small text trees in the bundle (config is tiny JSONC), one per symptom.

### 1. Stage — `plugins/framework/plugins/cli/bin/commands/release.ts`

Add a new step after 3.5 (asset-mirror prewarm, ~line 612). `release.ts` runs in the
full dev toolchain, so it can import codegen and reuse the exact, tested propagation:

```ts
// ── 3.6. Vendor config: raw git-layer tree (raw-diff/un-fork reads) + resolved
//         default seed (effective values). ──────────────────────────────────
console.log("\n[3.6] Vendoring config defaults...");

// (a) Raw git-layer tree → REPO_CONFIG_DIR at runtime (symptom 2).
console.log("  • git-layer config tree");
cpSync(join(root, "config"), join(out, "config"), { recursive: true });

// (b) Resolved default-for-everyone seed for the composition (symptom 1).
//     propagateConfigToUser writes <singularityDir>/config/<worktreeName>/… ;
//     an empty staging root yields ONLY resolved origins (+ @app scoped origins),
//     no personal overrides/ancestors.
console.log("  • resolved config defaults");
await propagateConfigToUser({
  root,
  worktreeName: opts.composition,
  singularityDir: join(out, "config-seed"),
});
```

- Import `propagateConfigToUser` from `@plugins/framework/plugins/tooling/plugins/codegen/core`
  (exported there; already used by `build.ts:886`). `cpSync`/`join` are already imported.
- `discoverConfigs(root)` walks the full `config/` tree (all plugins, not
  composition-filtered). Shipping origins for plugins absent from the composition is
  harmless — the released backend only reads the descriptors its plugins register.
- Update the staged-layout doc comment (`release.ts:32-50`) to list `config/` and
  `config-seed/`.

Resulting bundle layout:
- `<out>/config/<hier>/<name>.origin.jsonc`, `<name>.jsonc`, `@app/<id>/<name>.jsonc` — raw git-layer.
- `<out>/config-seed/config/<composition>/<hier>/<name>.origin.jsonc` (+ resolved `@app` origins) — seed.

### 2. Point — `plugins/infra/plugins/launcher/bin/launch.ts`

In the env block (before the `await import(...)` at line 93), add the read-only
override for symptom 2:

```ts
// The raw git-layer config tree is read by getRawFileContent (Settings "View
// raw") and gitBacksScope (per-app un-fork). REPO_ROOT resolves into the compiled
// binary's virtual FS, so point these at the vendored tree.
process.env.SINGULARITY_REPO_CONFIG_DIR ??= join(bundleRoot, "config");
```

After `seedReleaseAssetMirror(...)` (line 115) and before `bootSelfContainedApp`,
seed the writable CONFIG_DIR for symptom 1 (runs before the gateway spawns the
backend, so CONFIG_DIR is populated when the backend first reads it):

```ts
// Seed the resolved config defaults into the writable data dir (copy-if-absent),
// so a released app's config-backed defaults resolve on first boot. worktreeName
// = composition = the runtime SINGULARITY_WORKTREE, so this lands exactly where
// config-dir.ts reads (SINGULARITY_DIR/config/<worktree>).
seedReleaseConfig({
  bundleRoot,
  dataDir: process.env.SINGULARITY_DIR!,
  worktreeName: name,   // manifest.composition, already in scope in main()
  log: console.log,
});
```

`seedReleaseConfig` is imported from `@plugins/infra/plugins/launcher/server`
alongside the existing `seedReleaseAssetMirror` (bin imports only the launcher barrel).

### 3. Launcher boot step — `plugins/infra/plugins/launcher/server/internal/boot.ts`

Mirror `seedReleaseAssetMirror` (line 658): a thin wrapper that owns the boot step
and delegates the copy mechanics + CONFIG_DIR layout knowledge to config_v2 (so the
`config/<worktree>` path formula lives in one place):

```ts
export function seedReleaseConfig(opts: {
  bundleRoot: string;
  dataDir: string;
  worktreeName: string;
  log?: LogFn;
}): void {
  seedReleaseConfigDir(opts);   // from @plugins/config_v2/server
}
```

Export it from `plugins/infra/plugins/launcher/server/index.ts`. New import edge
launcher/server → config_v2/server (acyclic; config_v2 does not import launcher).

### 4. Seed mechanics — `plugins/config_v2/server`

config_v2 owns where config lives, so it owns the seed copy. Add
`seedReleaseConfigDir` (new internal file, exported from the server barrel):

```ts
export function seedReleaseConfigDir(opts: {
  bundleRoot: string; dataDir: string; worktreeName: string; log?: LogFn;
}): void {
  const src = join(opts.bundleRoot, "config-seed", "config", opts.worktreeName);
  const dest = join(opts.dataDir, "config", opts.worktreeName);   // == CONFIG_DIR formula
  if (!existsSync(src)) return;          // dev / no seed baked → no-op
  if (existsSync(dest)) return;          // already seeded (or user has a config dir) → don't clobber
  cpSync(src, dest, { recursive: true });
  opts.log?.(`Seeded config defaults → ${dest}`);
}
```

Keep the `join(dataDir, "config", worktreeName)` formula identical to
`config-dir.ts:11`. Optional anti-drift: extract a shared `configDirUnder(dataDir,
worktreeName)` helper used by both `config-dir.ts` and this seeder.

### 5. Env-override the two direct REPO_ROOT/config reads — `plugins/infra/plugins/paths`

Add to `plugins/infra/plugins/paths/core/internal/paths.ts` (next to `REPO_ROOT`,
the documented single source of truth for repo-relative paths):

```ts
export const REPO_CONFIG_DIR = process.env.SINGULARITY_REPO_CONFIG_DIR ?? join(REPO_ROOT, "config");
```

Export from core + server barrels. Then swap the two call sites (both already import
from `@plugins/infra/plugins/paths/server`):

- `plugins/config_v2/server/internal/registry.ts:648-649`
  `join(REPO_ROOT, "config", dir, …)` → `join(REPO_CONFIG_DIR, dir, …)`.
- `plugins/config_v2/server/internal/scope-fork.ts:33`
  `join(REPO_ROOT, "config", hierarchyPath, …)` → `join(REPO_CONFIG_DIR, hierarchyPath, …)`.

Drop the now-unused `REPO_ROOT` import from each file if no longer referenced.

## Critical files

| File | Change |
|---|---|
| `plugins/framework/plugins/cli/bin/commands/release.ts` | New step 3.6: vendor `config/` (raw) + `config-seed/` (propagated). Update layout doc comment. |
| `plugins/infra/plugins/launcher/bin/launch.ts` | Set `SINGULARITY_REPO_CONFIG_DIR`; call `seedReleaseConfig(...)`. |
| `plugins/infra/plugins/launcher/server/internal/boot.ts` | Add `seedReleaseConfig` wrapper. |
| `plugins/infra/plugins/launcher/server/index.ts` | Export `seedReleaseConfig`. |
| `plugins/config_v2/server/internal/seed-release.ts` (new) | `seedReleaseConfigDir` copy-if-absent. |
| `plugins/config_v2/server/index.ts` | Export `seedReleaseConfigDir`. |
| `plugins/infra/plugins/paths/core/internal/paths.ts` | Add `REPO_CONFIG_DIR`. |
| `plugins/infra/plugins/paths/{core,server}/index.ts` | Export `REPO_CONFIG_DIR`. |
| `plugins/config_v2/server/internal/registry.ts` | `REPO_ROOT` → `REPO_CONFIG_DIR` (line 648-649). |
| `plugins/config_v2/server/internal/scope-fork.ts` | `REPO_ROOT` → `REPO_CONFIG_DIR` (line 33). |

## Reused functions (do not reimplement)

- `propagateConfigToUser({root, worktreeName, singularityDir})` — `codegen/core/config-origin-gen.ts:500`. Resolves origin ⊕ override (+ `@app` deltas) into `<singularityDir>/config/<worktreeName>`. Reuse verbatim in `release.ts`.
- `seedReleaseAssetMirror` / `seedAssetMirrorCache` — `launcher/server/internal/boot.ts:658`. Shape to mirror for `seedReleaseConfig`.
- `runAssetMirrorPrewarm` — `release.ts:609`. Adjacent stage step to mirror for placement/logging.

## Verification (end-to-end)

1. Build this worktree: `./equin build`.
2. Cut a Sonata Tauri release:
   `./equin release --composition sonata --target tauri`
   (and `--target web` — identical staged tree). Confirm the log shows the new
   `[3.6] Vendoring config defaults...` step, and that
   `<out>/config-seed/config/sonata/apps/sonata/…/*.origin.jsonc` and `<out>/config/…`
   exist in the staged dir.
3. Boot the bare gateway and assert the surface renders end-to-end:
   `bun e2e/release-boot-verify.mjs` against the release bundle URL (per
   `plugins/release/CLAUDE.md`).
4. Confirm the fix visually — Library renders its view tabs (not the empty-state):
   ```
   bun e2e/screenshot.mjs --url http://sonata.localhost:<port>/…library… \
     --out /tmp/sonata-library
   ```
   Expect the Cards / All / Longest / Composed tabs + toolbar, not
   "No views configured".
5. First-run idempotency: relaunch the same bundle; `seedReleaseConfig` no-ops
   (dest exists), config still resolves, and a `setConfig` in the released app writes
   `<data>/config/sonata/…/<name>.jsonc` alongside the seeded origin.
6. Symptom 2 spot-check: in the released app, Settings → any config → "View raw"
   shows non-empty Git origin/override sections (reads `SINGULARITY_REPO_CONFIG_DIR`).
7. Dev unchanged: `SINGULARITY_REPO_CONFIG_DIR` / seed are unset in dev, so
   `REPO_CONFIG_DIR` falls back to `REPO_ROOT/config` and CONFIG_DIR is populated by
   `build` as before. Run `./equin check` (config-origins-in-sync, boundaries,
   type-check) to confirm no regressions.
8. Once verified, drop the "config defaults absent in a release" caveat from
   `plugins/release/CLAUDE.md`.
```
