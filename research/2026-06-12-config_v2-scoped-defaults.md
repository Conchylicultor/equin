# config_v2: code-declared per-app scoped defaults

> **SUPERSEDED by [`2026-06-12-config_v2-git-scoped-config.md`](./2026-06-12-config_v2-git-scoped-config.md).**
> This v1 proposed declaring scoped defaults in TypeScript (`defineConfig({ scopeDefaults })`).
> The user rejected code-side declaration: scopes must be expressed in the **git
> `config/` layer** (an agent commits a scoped JSONC file), never in code. Kept
> for the record (the resolution/predicate/propagation analysis carries over).

## Context

`config_v2` descriptors (`defineConfig`) can ship exactly **one global default per
field** in code. There is no way to declare, in version-controlled code, a
*different* default for a specific app scope — e.g. "field `captureUrlByDefault`
defaults to `false` for app `agent-manager`, `true` everywhere else."

Today the only way to make a scope differ from the global default is a **runtime**
`forkScope("app:<id>")` plus a JSONC override written under
`~/.singularity/config/<wt>/…/@app/<id>/`. That directory is outside the repo, so
the override does **not** exist on a fresh checkout/install — the app-specific
default silently vanishes. Build-time codegen emits only a single global
`config/<hier>/<name>.origin.jsonc` per descriptor; there is no per-scope origin.

This is why the recent `captureUrlByDefault` work (commit `a49888f59`) bypassed
config entirely and used an `Apps.App` slot-metadata boolean instead — a static
per-app constant, but **not user-overridable** and not part of the config model.

**Goal:** a first-class primitive that lets a plugin declare scoped defaults in
code, has codegen emit per-scope origins, propagates them on `./equin build`
so they apply on a fresh install, resolves them at runtime, and keeps them
**user-overridable** through the existing origin/override/conflict machinery.

The design mirrors the existing three-layer model exactly: a scoped default is
"just another origin, at a scoped path." Everything (hashing, propagation,
conflict detection, settings raw-layer view, reset-to-default) composes with it.

## Design

### 1. Declaration API (`defineConfig`)

```ts
defineConfig({
  scope: "app",
  fields: { captureUrlByDefault: boolField({ default: true }) },
  scopeDefaults: {
    "agent-manager": { captureUrlByDefault: false },
  },
});
```

- New optional `scopeDefaults?: Record<string, Partial<ConfigValues<F>>>` on the
  `defineConfig` opts and on the frozen `ConfigDescriptor`. Keys are **bare app
  ids** (`"agent-manager"`), values are partial field deltas.
- `defineConfig` validates loudly (fail-fast at declaration):
  - `scopeDefaults` present ⇒ `scope` must be set (`"app"`).
  - Every delta key ∈ `fields`.
  - Every delta value passes `field.schema.parse`.
  - **Reject a `scopeDefault` on a provider-backed (secret) field** — a secret
    in version control is a footgun; secrets are never written to JSONC origins
    anyway (see `forkScope`'s existing strip).
- App-id *validity* is **not** checked here — `config_v2` stays app-agnostic (it
  never imports the apps plugin). See "Follow-ups" for an optional cross-check.

Files: `plugins/config_v2/core/internal/types.ts`,
`plugins/config_v2/core/internal/define-config.ts`.

### 2. Codegen — emit per-scope origins

In `config-origin-gen.ts`:

- `renderConfigOriginContent`: for each descriptor, after the base origin, emit
  one scoped origin per `scopeDefaults` entry at relPath
  `<hier>/@app/<id>/<name>.origin.jsonc`. Body = **full merged snapshot**
  `{ ...baseDefaults, ...scopeDelta }` (mirrors `forkScope`'s full-doc snapshot,
  keeps the scoped origin diffable against base in the settings UI), `@hash` of
  the merged doc.
- **`OriginDefaultsProvider` composition (risk):** the merged base must be
  `originDefaults?.(descriptor, hier) ?? descriptor.defaults` **then** `⊕ scopeDelta`
  — *not* `descriptor.defaults ⊕ scopeDelta`. Otherwise a reorder-style
  descriptor (which materializes its catalog via `originDefaults`) would emit a
  scoped origin missing the catalog and a diverging hash.
- `loadConfigDescriptorsByOriginPath`: map the same scoped relPaths → descriptor
  so the check can schema-validate them.

### 3. Propagation — reach the user dir on a fresh install

`propagateConfigToUser` currently iterates `discoverConfigs` (base only). Add a
scope loop: for each discovered config, for each `descriptor.scopeDefaults` key,
build the scoped git proxies at `config/<hier>/@app/<id>/{name}.origin.jsonc` (+
optional `.jsonc`) and `propagate()` them into
`~/.singularity/config/<wt>/<hier>/@app/<id>/…`. **This is the lynchpin of the
fresh-checkout story** — without it the committed scoped origin never reaches the
user dir, `discoverScopeIds` finds no `@app/<id>` dir, and the feature silently
does nothing.

File: `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts`.

### 4. Runtime resolution — two predicates, cleanly separated

The current `isForked` (scoped **override** exists) is overloaded for two
concepts that **diverge** once a scope can have a code-shipped origin with no
override. Split them:

- **`scopeHasOwnConfig(descriptor, scopeId)`** *(new, internal)* = scoped
  **origin OR override** exists. Drives:
  - `getConfig` — return `scoped.values` when the scope has its own config.
  - `notifyValues` / `notifyTiers` — skip re-notifying a scope that is decoupled
    from base (a code-shipped scope is decoupled, same as a user fork).
  - `initRegistry` rehydration — build a scoped cache entry for code-shipped
    scopes too. (`discoverScopeIds` already finds the propagated `@app/<id>` dir;
    just swap its `isForked` gate for `scopeHasOwnConfig`.)
- **`isForked` / `isScopeForked`** *(unchanged, override-only)* = the user has
  **explicitly** forked. Drives only the theme-customizer "Customize for app"
  toggle. A code-shipped default alone must **not** flip the toggle ON — keeps
  the toggle honest and prevents an unrelated descriptor's code default from
  making every app read as "theme-customized."

This split is the core correctness move. With it, `getConfig(themeDescriptor,
"app:X")` still returns base for an app that only has a code default on some
*other* (e.g. task-draft) descriptor, while `getConfig(taskDraftDescriptor,
"app:X")` returns the code default. Both independent and correct.

File: `plugins/config_v2/server/internal/registry.ts` (add `scopeHasOwnConfig`,
swap three call sites; leave `isForked`/`isScopeForked` as-is).

### 5. Web read — flash-free via the descriptor's own scopeDefaults

`descriptor.scopeDefaults` is imported into the web bundle, so the code-shipped
scoped value is known **synchronously** on the client. Use it as the optimistic
fallback — **no per-app boot hydration needed**:

```ts
const forked = useScopeForked(scopeId);                  // user-forked only
const appId = scopeId ? scopeAppId(scopeId) : undefined; // "app:x" → "x"
const codeDelta = appId ? descriptor.scopeDefaults?.[appId] : undefined;
const wantScoped = !!scopeId && (forked || codeDelta != null);
const scopedRes = useResource(configV2Resource, wantScoped ? { path, scopeId } : { path });
const globalRes = useResource(configV2Resource, { path });

if (wantScoped && !scopedRes.pending) return scopedRes.data;
// Optimistic, flash-free: global (boot-hydrated, non-pending) ⊕ code delta
if (wantScoped && !globalRes.pending) return { ...globalRes.data, ...(codeDelta ?? {}) };
if (!globalRes.pending) return globalRes.data;
return descriptor.defaults;
```

For a non-customized app this fallback **equals** the eventual server value, so
the toggle/value paints correctly on the first frame. For a customized app it
shows the code default for one frame before the user override loads — strictly
better than today's global flash. No new boot task; `config_v2` stays
app-agnostic (it only parses its own `app:<id>` wire format via a new core
`scopeAppId` helper).

Files: `plugins/config_v2/web/internal/use-config.ts`,
`plugins/config_v2/core` (new `scopeAppId(scopeId)` util in the scope wire-format
area; export from core barrel).

### 6. `forkScope` / `deleteScope` — preserve code defaults

- **`forkScope`**: snapshot `getConfig(descriptor, scopeId)` (scope-effective)
  instead of `getConfig(descriptor, "")` (base). Forking an app that already has
  a code default preserves it instead of resetting to global.
- **`deleteScope`** (un-customize → **fall back to the code-shipped default**,
  per decision): remove only the user **override** (`.jsonc`). Keep the scoped
  **origin** when the descriptor has a `scopeDefaults` entry for that app (the
  code default is the floor); remove the origin only for pure user forks (no code
  default). `rmdir` the `@app/<id>` dir only when nothing remains. After
  un-customizing, a code-defaulted descriptor reverts to its **in-code per-app
  default**, not global, and `isScopeForked` returns false (toggle OFF).

File: `plugins/config_v2/server/internal/scope-fork.ts`.

### 7. Scoped-read fidelity in settings (both fixed now, per decision)

- **`getRawFileContent` (R6):** its git-layer paths (`gitOriginPath` /
  `gitOverridePath`) are hard-coded to the base path with no `@app/` segment, so
  "View raw layers" shows the *base* git origin for a scoped read. Derive the git
  path's scope segment from `scopeSegment(scopeId)`, same as the user-layer paths.
  File: `plugins/config_v2/server/internal/registry.ts`.
- **Scoped conflicts (R8):** `computeAllConflicts` iterates `descriptorByPath`
  with base-only `CONFIG_DIR` paths, so a stale **scoped** override (code default
  changed + re-propagated under a user's customization) is honored on disk
  (`effective` → origin wins) but **never surfaced** for reconcile. Extend
  `computeAllConflicts` to also scan each descriptor's discovered scopes
  (`discoverScopeIds`) and emit conflict entries keyed by `(storePath, scopeId)`.
  Requires a `scopeId?` on `configV2ConflictsSchema`'s entry/key and the settings
  conflict banner reading it. Files:
  `plugins/config_v2/server/internal/resource.ts`,
  `plugins/config_v2/core/internal/resource.ts` (schema),
  `plugins/config_v2/plugins/settings/web/…` (banner). This is the larger of the
  two reader fixes; `computeTiers` already handles scopes correctly (precedent to
  mirror).

### 8. Check — extends almost for free

`config-origins-in-sync` already (a) diffs the full `renderConfigOriginContent`
map against disk, (b) orphan-scans **all** committed `*.origin.jsonc` (incl.
`@app/`), (c) hash+schema-validates **all** `*.jsonc`. Once codegen emits scoped
relPaths and `loadConfigDescriptorsByOriginPath` maps them, the check covers
scoped origins/overrides with **no edit**. A scoped origin for a removed
`scopeDefaults` entry is correctly flagged as an orphan. *(Verify only — no code
change expected.)*

## Files to change (summary)

| File | Change |
|------|--------|
| `config_v2/core/internal/types.ts` | `scopeDefaults?` on `ConfigDescriptor` |
| `config_v2/core/internal/define-config.ts` | accept + validate `scopeDefaults` |
| `config_v2/core/internal/scope-paths.ts` or new core util | `scopeAppId(scopeId)`; export from core |
| `config_v2/core/internal/resource.ts` | `scopeId?` on conflicts schema (R8) |
| `…/codegen/core/config-origin-gen.ts` | emit + map + **propagate** scoped origins (R1, R5) |
| `config_v2/server/internal/registry.ts` | `scopeHasOwnConfig`; swap 3 call sites; `getRawFileContent` scoped git path (R6) |
| `config_v2/server/internal/resource.ts` | scoped conflicts in `computeAllConflicts` (R8) |
| `config_v2/server/internal/scope-fork.ts` | `forkScope` scope-effective snapshot; `deleteScope` keep code origin (R2) |
| `config_v2/web/internal/use-config.ts` | scoped subscription + optimistic code-default fallback |
| `config_v2/plugins/settings/web/…` | conflict banner reads scoped entries (R8) |
| `config_v2/CLAUDE.md` | document scoped defaults (declaration + semantics) |

No change expected: `config-origins-in-sync` check, the web boot tasks
(`configBootTask`, `themeScopeBootTask`), `computeTiers`.

## Edge cases / risks

- **R1 (high) — propagation is net-new code**, not "free reuse"; without the
  scope loop the feature silently no-ops on fresh checkout. Do first.
- **R2 (high) — `deleteScope`** must keep code-shipped origins or un-customizing
  transiently regresses to global until the next build. Handled in §6.
- **R5 (med) — `originDefaults` merge order** for reorder-style descriptors. §2.
- **R8 (med) — scoped conflicts** need a key-space + schema + UI extension. §7.
- **R6 (low) — raw-layer git path** wrong for scoped reads. §7.
- **R9 (low) — secret fields**: reject scoped defaults on provider-backed fields
  in `defineConfig`; codegen never emits them (existing strip). §1.
- **Pre-build window:** a code default declared but not yet propagated — client
  optimistically shows the (intended) code default while the server returns base
  until `./equin build`. Self-heals on build; acceptable.
- **Schema evolution:** scoped origins get default-backfill + the check's schema
  pass for free; a new field marks scoped overrides stale per-scope via R8.

## Follow-ups (out of scope, file as tasks)

- Optional `apps`-side check cross-referencing `scopeDefaults` keys against
  registered `Apps.App` ids (catches a typo'd app id at check time). Lives in
  `plugins/apps/check/` — it can import both registries; `config_v2` stays
  app-agnostic.

## Verification

1. Add a temporary `scope: "app"` config with
   `scopeDefaults: { "agent-manager": { … } }` to a test descriptor (or wire the
   real `captureUrlByDefault` as a config field).
2. `./equin build` — confirm `config/<hier>/@app/agent-manager/<name>.origin.jsonc`
   is generated and committed-clean, and that
   `~/.singularity/config/<wt>/<hier>/@app/agent-manager/<name>.origin.jsonc` is
   propagated.
3. `./equin check config-origins-in-sync` — passes; then hand-edit the
   scoped origin and confirm it fails (sync + orphan + schema coverage).
4. Server: `mcp__singularity__query_db` not needed — instead read via a scoped
   `getConfig` log, or assert through the UI: open the app at
   `http://<wt>.localhost:9000` for `agent-manager` vs another app and confirm
   the field resolves to the scoped vs global default.
5. **Flash test (Playwright):** hard-reload the `agent-manager` app and confirm
   the control paints the scoped value on the first frame (no global→scoped
   flicker). Use `e2e/screenshot.mjs` with `--click`/state assertion.
6. Theme customizer regression: confirm the "Customize for app" toggle for an app
   that has an *unrelated* code-shipped default still reads **OFF** (not coupled),
   and that fork → edit → un-customize falls back to the **code default**, not
   global.
7. Settings: trigger a per-scope conflict (change a code default after a user
   scoped override exists, rebuild) and confirm the conflict banner surfaces it
   for that scope; confirm "View raw layers" shows the scoped git origin.
