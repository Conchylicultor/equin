# config_v2: git-expressed per-app config scopes

## Context

`config_v2` can express a per-app config difference only as a **runtime**
`forkScope("app:<id>")` + JSONC edit under `~/.singularity/config/<wt>/…/@app/<id>/`.
That directory is per-user and outside the repo, so an app-specific value does
**not** survive a fresh checkout/install. There is no version-controlled way to
say "for app `agent-manager`, this field is X."

The existing three-layer model already gives agents a documented, committed way
to customize the **base** (global) config: write `config/<hier>/<name>.jsonc`
(an override anchored by `// @hash` to the codegen-generated
`config/<hier>/<name>.origin.jsonc`), and `./equin build` propagates it to
every fresh install.

**This plan extends that same git-layer mechanism to app scopes.** An agent
customizes app `<id>` by committing `config/<hier>/@app/<id>/<name>.jsonc` — a
scoped override anchored to the same base origin. No code declares scopes;
`defineConfig` is unchanged. Scopes are discovered from committed files, not from
TypeScript.

> Rejected alternative (v1, [`…-scoped-defaults.md`](./2026-06-12-config_v2-scoped-defaults.md)):
> declaring `defineConfig({ scopeDefaults })` in code. The user wants the
> expression to live in version control as data (git `config/`), reachable and
> editable by agents, not baked into a TS API.

## The model: a scoped override is a base-anchored delta

```
Code (defineConfig)        →  git config/                          →  ~/.singularity/config/
 defaults + schema            <hier>/<name>.origin.jsonc  (codegen)    <hier>/<name>.origin.jsonc   (propagated base)
                              <hier>/<name>.jsonc         (agent,opt)  <hier>/<name>.jsonc          (runtime base edits)
                              <hier>/@app/<id>/<name>.jsonc (agent)    <hier>/@app/<id>/<name>.origin.jsonc (propagated scope)
                                                                       <hier>/@app/<id>/<name>.jsonc (runtime scope edits)
```

- **There is exactly one origin per descriptor — the base origin** (codegen, from
  `defineConfig` defaults). A scoped override is a delta on top of base and
  anchors its `// @hash` to the **base** origin's hash. No scoped origin file is
  ever committed (codegen has no scoped defaults to render — and never will).
- **Scoped resolution = base-effective ⊕ scoped-delta**, computed at propagation
  (build) time and frozen into the user scoped origin, mirroring how base
  propagation freezes `effective(gitOrigin, gitOverride)` into the user base
  origin. A scoped override may be **partial** (express only the fields that
  differ); schema default-backfill fills the rest, identical to base overrides.
- Decoupled-from-runtime-base, like every existing fork: once a scope has its own
  config, runtime base edits don't bleed into it until the next build recomputes
  `baseEff ⊕ delta`. Consistent with current `forkScope` snapshot semantics.

## Agent workflow (the documented mechanism — goes in `config_v2/CLAUDE.md`)

To customize app `<id>` for the descriptor at `<hier>` (config name `<name>`,
usually `config`):

1. Create `config/<hier>/@app/<id>/<name>.jsonc`.
2. Put only the fields that differ for that app, e.g.
   `{ "captureUrlByDefault": false }`.
3. Line 1: `// @hash <hash>`, copied from the base origin
   `config/<hier>/<name>.origin.jsonc`.
4. `./equin build` — propagates it to `~/.singularity/config/…/@app/<id>/`.
   The app at `http://<wt>.localhost:9000` (for app `<id>`) now resolves the
   scoped values; every other app keeps the base value.
5. `./equin check config-origins-in-sync` — validates the `@hash` against
   the base origin and the document against the schema.

Symmetric to the existing base-override workflow already in `CLAUDE.md`; the only
new idea is the `@app/<id>/` path segment.

## Changes by area

### 1. Propagation — discover & propagate committed scopes (the core work)

`propagateConfigToUser` (`…/codegen/core/config-origin-gen.ts`) currently iterates
`discoverConfigs` (base only). Add a scope pass: for each discovered config, scan
the **repo** dir `config/<hier>/@app/` for `<id>` subdirs containing
`<name>.jsonc`. For each committed scope:

```
baseEff   = effective(gitBaseOrigin, gitBaseOverride)         // full base config
delta     = read(config/<hier>/@app/<id>/<name>.jsonc)        // agent's scoped delta
upstream  = readonlyProxy({ ...baseEff, ...delta })           // resolved scope config
propagate(upstream, userScopedOrigin, userScopedOverride)     // → user @app/<id>/origin
```

Writes `~/.singularity/config/<wt>/<hier>/@app/<id>/<name>.origin.jsonc` (with a
fresh content hash) and flags a conflict if a runtime user scoped override is
stale — exactly the base path's `propagate()` behavior. This is the lynchpin: it
is what makes a committed scope reach a fresh install.

`generateConfigOrigins` (codegen of origin files) is **unchanged** — no scoped
origins are generated.

### 2. Runtime resolution — `scopeHasOwnConfig`, two predicates split

In `registry.ts`, today's `isForked` (scoped **override** exists) is overloaded.
Split the concepts, because a committed scope has a user scoped **origin** but no
override:

- **`scopeHasOwnConfig(descriptor, scopeId)`** *(new, internal)* = scoped
  **origin OR override** exists. Drives `getConfig` (return scoped values),
  `notifyValues`/`notifyTiers` (skip the decoupled scope on a base change), and
  the `initRegistry` rehydration gate (build a cache entry for committed scopes —
  `discoverScopeIds` already finds the propagated `@app/<id>` dir; swap its
  `isForked` gate for `scopeHasOwnConfig`).
- **`isForked` / `isScopeForked`** *(unchanged, override-only)* — drive only the
  theme-customizer "Customize for app" toggle. A committed scope must **not** flip
  that toggle ON (it's not a user theme fork), and a committed scope on an
  unrelated descriptor must not make every app read as "theme-customized."

### 3. Check — anchor scoped overrides to the base origin

`config-origins-in-sync` validates every committed `*.jsonc` override's `@hash`
against its sibling `*.origin.jsonc`. A scoped override has no sibling scoped
origin, so add a small path rule: when a `.jsonc` path contains an `@app/<id>`
segment, its anchor origin is the **base** origin with that segment stripped
(`config/<hier>/<name>.origin.jsonc`). Apply the same stripping for the descriptor
lookup (`descriptorsByOriginRel`). Schema validation then runs on the (partial)
scoped doc via the existing default-backfilling `safeParse` — partial passes,
wrong-typed fields fail. The orphan pass is unaffected (it only scans
`*.origin.jsonc`, and no scoped origins exist).

### 4. Web read — flash-free via committed scopes in the global boot snapshot

There is no longer a code-side default to read synchronously on the client, so
flash-free first paint comes from boot hydration. Keep it **app-agnostic and
bounded** by pre-hydrating only **committed** scopes (version-controlled = part of
the app definition, like global; runtime user forks stay handled by the existing
`themeScopeBootTask`):

- `getConfigSnapshot()` (no scopeId) gains a `scopes: { scopeId, path, values }[]`
  built by scanning, per descriptor, the **repo** `config/<hier>/@app/*` dirs and
  resolving each via `getConfig(descriptor, "app:<id>")`. Bounded by committed
  config (sparse).
- `configBootTask` hydrates `configV2Resource {path, scopeId}` for each entry.
- `useConfig(descriptor, { scopeId })`: subscribe to the scoped resource when
  `scopeId` is given; otherwise global. While the scoped read is pending, fall
  back to the (boot-hydrated, non-pending) global value — which equals the scoped
  value for any app **without** its own config, so there's no flash there either.
  Committed scopes are boot-hydrated → non-pending → correct on the first frame.
  Drops the current `useScopeForked`-gating of the scoped subscription (that
  coupling is what §2 untangles); the theme customizer keeps its own gating by
  passing `scopeId: undefined` when it wants global.

Consumers thread the app scope themselves (they import apps; `config_v2` stays
agnostic), e.g. `useConfig(cfg, { scopeId: appId ? \`app:${appId}\` : undefined })`
with `appId = useCurrentAppId()`.

### 5. `forkScope` / `deleteScope` — coexist with committed scopes

- `forkScope`: snapshot `getConfig(descriptor, scopeId)` (scope-effective)
  instead of `getConfig(descriptor, "")`, so forking an app that already has a
  committed scope preserves it rather than resetting to base.
- `deleteScope` (theme "un-customize"): remove only the user scoped **override**;
  **keep** the user scoped **origin when a committed git scope backs it**
  (`config/<hier>/@app/<id>/<name>.jsonc` exists in the repo) — the app falls back
  to its committed per-app config, not global. Remove both only for a pure runtime
  fork with no git backing. `rmdir` the `@app/<id>` dir only when nothing remains.

### 6. Scoped-read fidelity in settings (fix now, per earlier decision)

- **`getRawFileContent` (R6):** its git-layer paths are hard-coded to the base
  path. For a scoped read, point `gitOverride` at
  `config/<hier>/@app/<id>/<name>.jsonc` (scope segment via `scopeSegment(scopeId)`)
  while `gitOrigin` stays the base origin (the anchor). File: `registry.ts`.
- **Scoped conflicts (R8):** `computeAllConflicts` scans base-only `CONFIG_DIR`
  paths, so a stale user scoped override (committed delta changed + re-propagated
  under a runtime edit) is honored on disk but never surfaced for reconcile.
  Extend it to also scan each descriptor's discovered scopes (`discoverScopeIds`),
  keyed by `(storePath, scopeId)`. Touches `computeAllConflicts` (resource.ts),
  `configV2ConflictsSchema` (core), and the settings conflict banner.
  `computeTiers` already handles scopes — mirror it.

## Files to change (summary)

| File | Change |
|------|--------|
| `…/codegen/core/config-origin-gen.ts` | `propagateConfigToUser` discovers + propagates committed `@app/<id>` scopes (§1) |
| `config_v2/server/internal/registry.ts` | `scopeHasOwnConfig`; swap 3 call sites; `getRawFileContent` scoped git path (§2, §6) |
| `config_v2/server/internal/resource.ts` | `scopes` in global snapshot (§4); scoped conflicts in `computeAllConflicts` (§6) |
| `config_v2/core/internal/resource.ts` | `scopeId?` on conflicts schema; `scopes` on snapshot result (§4, §6) |
| `config_v2/server/internal/scope-fork.ts` | `forkScope` scope-effective snapshot; `deleteScope` keep git-backed origin (§5) |
| `…/checks/plugins/config-origins-in-sync/check/index.ts` | scoped override → strip `@app/<id>` to find base anchor origin + descriptor (§3) |
| `config_v2/web/internal/boot.ts` | hydrate committed scopes from snapshot (§4) |
| `config_v2/web/internal/use-config.ts` | subscribe scoped on `scopeId`; global fallback while pending (§4) |
| `config_v2/plugins/settings/web/…` | conflict banner reads scoped entries (§6) |
| `config_v2/CLAUDE.md` | document the agent scoped-override workflow + the `@app/<id>` path |

No change: `defineConfig` / core types, `generateConfigOrigins` (base origins
only), `computeTiers`, `themeScopeBootTask`.

## Edge cases / risks

- **(high) propagation discovery** is the load-bearing add; without it a committed
  scope never reaches a fresh install and the feature silently no-ops.
- **(med) check anchor stripping** — get the `@app/<id>`-segment detection right or
  scoped overrides fail the hash/descriptor lookup against a non-existent sibling.
- **(med) scoped conflicts (R8)** — key-space + schema + banner extension.
- **(low) snapshot payload** — bounded to committed scopes by design; note it.
- **(low) raw-layer git path (R6)**; **deleteScope git-backed check (§5)**.
- **Decoupled base:** a committed scope's non-overridden fields track git base as
  of the last build, not runtime base edits (consistent with existing forks).
  Document it.
- **Schema evolution:** scoped overrides get default-backfill + the check's schema
  pass for free; a base-default change marks committed scopes' propagated
  conflicts per-scope via R8.

## Verification

1. Pick a real per-app case (e.g. wire `captureUrlByDefault` as a `task-draft-form`
   config field read with `scopeId = app:<current>`, replacing the slot-metadata
   constant) — or use a throwaway descriptor.
2. Commit `config/<hier>/@app/agent-manager/config.jsonc` = `{ <field>: <value> }`
   with `// @hash <base-origin-hash>`.
3. `./equin build` — confirm
   `~/.singularity/config/<wt>/<hier>/@app/agent-manager/config.origin.jsonc` is
   propagated as `baseEff ⊕ delta`.
4. `./equin check config-origins-in-sync` — passes; corrupt the `@hash` and
   confirm it fails against the **base** origin; add a wrong-typed field and
   confirm schema failure.
5. UI: open the app for `agent-manager` vs another app at
   `http://<wt>.localhost:9000` and confirm scoped vs base resolution.
6. **Flash test (Playwright, `e2e/screenshot.mjs`):** hard-reload the
   `agent-manager` app; the control paints the scoped value on the first frame (no
   global→scoped flicker).
7. Theme regression: the "Customize for app" toggle for an app that has only a
   committed (non-theme) scope still reads **OFF**; fork → edit → un-customize
   falls back to the **committed** scope value, not global.
8. Settings: change the base default after a runtime scoped edit, rebuild, and
   confirm the conflict banner surfaces the per-scope conflict; "View raw layers"
   shows the scoped git override.
