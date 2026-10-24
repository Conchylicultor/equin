# config_v2 — close the silent half-registration gap

## Context

A `config_v2` field reads back as defaults/empty in the browser when its descriptor
is registered on only one of the two required sides (web `ConfigV2.WebRegister` vs
server `ConfigV2.Register`). The failure is silent, which contradicts the project's
"fail loudly" principle and repeatedly traps agents.

Investigation showed the problem is **half-fixed** and the existing safety net is
**too weak**:

1. **Web-missing** (server has `Register`, web lacks `WebRegister`): `useConfig`
   *already throws loudly* — `plugins/config_v2/web/internal/use-config.ts:19-24`.
   No work needed here.

2. **Server-missing** (web has `WebRegister`, server lacks `Register`): **still
   silently degrades.** The path is absent from the boot snapshot (the snapshot
   iterates `descriptorByPath`, which is server-only —
   `plugins/config_v2/server/internal/resource.ts:104`), so the resource stays
   `pending` and `useConfig` falls through to `return descriptor.defaults`
   (`use-config.ts:46-48`). The server loader *does* throw
   (`resource.ts:67-73`), but that error never reaches the client UI. **This is
   the remaining silent failure.**

3. **An existing check** `config-v2:registrations-paired`
   (`plugins/config_v2/check/index.ts`) is meant to catch this, but is brittle:
   - It only greps `*/server/index.ts` and `*/web/index.ts`. It **entirely misses
     `reorder`**, which registers in `web/internal/config-registrations.ts` /
     `server/internal/config-registrations.ts` via `.map()`.
   - It is **plugin-dir-level, not storePath-level** — a plugin registering
     descriptor A on both sides but B on only one passes.
   - It does **not** verify the two sides agree on `storePath`, so it would *not*
     have caught the exact bug fixed in commit `6c38b065c` (web
     `reorder/apps.app.jsonc` vs server `apps/apps.app.jsonc`).

A true "single registration point that wires both sides" is **not cleanly
feasible**: web and server are separate bundles, descriptor object identity does
not cross runtimes, and `storePath` needs the loader-injected `pluginId` — so the
two-sided contribution is fundamental. The structural fix is therefore **build-time
prevention (a storePath-accurate check) + a loud runtime guard** so a
half-registered field can never silently degrade.

Decisions (confirmed with user): do **both** parts; the check uses the
**barrel-import / storePath-level** approach.

## Part 1 — Rewrite the check to be storePath-accurate (build-time prevention)

Replace the grep-based body of `plugins/config_v2/check/index.ts` with a
registry-accurate comparison that reads the **actual registered contributions** on
both sides (location-independent, descriptor-level, and catches storePath
mismatches).

**Model it on `plugins/plugin-meta/plugins/facets/check/index.ts`** (the
`facets:render-complete` check), which already does exactly this dance:

```ts
const tree = await buildPluginTree(pluginsRoot, { skipBarrelImport: true });
registerBarrelStubs(join(pluginsRoot, ".."));
for (const node of tree.byDir.values()) {
  const mod = await importBarrel(join(node.dir, "web", "index.ts"));   // and "server"
  const def = mod.default as { contributions?: Array<Record<string, unknown>> };
  // inspect def.contributions
}
```

Imports to reuse:
- `buildPluginTree` from `@plugins/plugin-meta/plugins/plugin-tree/core`
- `registerBarrelStubs`, `importBarrel` from `@plugins/plugin-meta/plugins/barrel-import/core`

**Algorithm** — build two `Set<string>` of storePaths across all plugin nodes:

For each `node` in `tree.byDir.values()`:
- pluginId for the node is `node.hierarchyId` (this is the loader-injected
  `_pluginId`; barrels carry no `id:` per the barrel-purity rule — confirmed by the
  contributions facet, which falls back to the node id).
- If `node/web/index.ts` exists, import it; for every contribution `c` with
  `c._slotId === "config-v2.web-register"`, compute
  `storePath = `${c.pluginId ?? node.hierarchyId}/${c.descriptor.name}.jsonc`` and
  add to `webPaths`.
- If `node/server/index.ts` exists, import it; for every contribution `c` that is a
  `ConfigV2.Register` contribution, compute the same `storePath` and add to
  `serverPaths`.

> Identifying the server contribution: `ConfigV2.Register` is built via
> `defineServerContribution<ConfigRegistration>("ConfigV2.Register")`
> (`plugins/config_v2/server/internal/contribution.ts`). The resulting object
> carries a `_kind` symbol whose `.description === "ConfigV2.Register"` plus a
> `descriptor` field. Verify the exact discriminator at implementation time by
> importing one server barrel and logging a contribution; match on
> `(c._kind as symbol | undefined)?.description === "ConfigV2.Register"` (fall back
> to "has a `descriptor` whose shape matches `ConfigDescriptor` and is not a
> web-slot contribution" only if no stable kind tag exists). This mirrors how the
> `registrations` facet reads `def.register[]`/`def.contributions[]` from server
> barrels.

Then report:
- `webPaths \ serverPaths` → **web-only** (silently degrades at runtime — the bug
  this whole task is about). Hint: add `ConfigV2.Register({ descriptor })` (with the
  same `pluginId` if an override is used) on the server side.
- `serverPaths \ webPaths` → **server-only** (`useConfig` throws at runtime). Hint:
  add `ConfigV2.WebRegister({ descriptor })` on the web side.

Keep the check `id: "config-v2:registrations-paired"` and the `Check`/`CheckResult`
local type aliases (the file is a plugin-contributed check, discovered by
convention — no registry edit needed). Report storePaths (not just dirs) in the
failure message so the mismatch is unambiguous.

**Edge cases to honor:**
- A plugin can register a descriptor under *another* plugin via `pluginId` override
  (reorder). Comparing computed `storePath` (not registering-dir) handles this
  correctly and is what makes the check catch the `6c38b065c` mismatch class.
- Barrel import failure on a node: fail the check loudly with the offending barrel
  path (same as the facets check does), do not skip silently.

## Part 2 — Loud runtime guard in `useConfig` (no silent degrade ever)

Make the server-missing read path throw instead of returning defaults, mirroring the
existing web-missing throw. Defense-in-depth for anything the build-time check can't
see (e.g. a descriptor registered only at runtime).

The boot task already learns the authoritative set of server-registered storePaths:
`configBootTask` fetches `{ global }` keyed by storePath
(`plugins/config_v2/web/internal/boot.ts:14`). Capture that key-set and assert
membership in `useConfig`.

**New file `plugins/config_v2/web/internal/server-paths.ts`** — a tiny module store
(mirror the `useSyncExternalStore` pattern in
`plugins/reorder/web/internal/edit-mode-store.ts`):
- holds `Set<string> | null` (null = boot not yet completed),
- `setKnownServerPaths(paths: string[])`, `useKnownServerPaths()` (subscribe +
  snapshot), and a non-hook `getKnownServerPaths()` if needed.

**`boot.ts`** — after the hydration loop, call
`setKnownServerPaths(Object.keys(global ?? {}))`. Set it only on the success path so
a failed boot leaves it `null` (no false-positive throws; reads degrade gracefully
as today via the WS sub).

**`use-config.ts`** — read `useKnownServerPaths()` (reactive). After computing
`path` (the existing web-registration lookup is unchanged and still throws on
web-missing):
- if `known !== null && !known.has(path)` → **throw loudly**, e.g.
  `[config-v2] useConfig: descriptor "<name>" is registered on web (storePath
  "<path>") but the server has no matching ConfigV2.Register — add
  ConfigV2.Register({ descriptor }) to the plugin's server/index.ts.`
- otherwise proceed exactly as today; the `known === null` (still-booting) window
  keeps the existing `descriptor.defaults` race fallback (`use-config.ts:47-48`),
  avoiding false positives before boot completes.

This is global-resource membership only; the scoped/forked fallback logic
(`use-config.ts:37-46`) is untouched (scoped values legitimately load lazily; global
is always present in the snapshot for a registered descriptor).

## Critical files

- `plugins/config_v2/check/index.ts` — rewrite body (Part 1).
- `plugins/config_v2/web/internal/server-paths.ts` — new store (Part 2).
- `plugins/config_v2/web/internal/boot.ts` — capture known paths (Part 2).
- `plugins/config_v2/web/internal/use-config.ts` — membership assertion (Part 2).
- Reference only: `plugins/plugin-meta/plugins/facets/check/index.ts` (check
  pattern), `plugins/reorder/web/internal/edit-mode-store.ts` (store pattern),
  `plugins/config_v2/server/internal/contribution.ts` (server contribution shape),
  `plugins/config_v2/web/internal/store-path.ts` (`storePathOf` derivation to match).

## Verification

1. **Check is correct on a clean tree:**
   `./equin check config-v2:registrations-paired` → passes (no half/mismatched
   registrations today, including `reorder`, which the old grep silently ignored).

2. **Check catches web-only (the target bug):** temporarily remove the
   `ConfigV2.Register(...)` line from a small plugin's `server/index.ts` (e.g.
   `floating-bar`) → re-run the check → it must fail and name
   `floating-bar/floating-bar.jsonc` (or that descriptor's storePath) as web-only.
   Restore.

3. **Check catches server-only:** temporarily remove the corresponding
   `ConfigV2.WebRegister(...)` → check fails naming it server-only. Restore.

4. **Check catches a storePath mismatch:** temporarily change one side's `pluginId`
   override on a `reorder` registration so web/server disagree → check fails with the
   two differing storePaths (this is the `6c38b065c` class the old check missed).
   Restore.

5. **Runtime guard fails loudly:** with `floating-bar` server registration removed
   (and the check temporarily bypassed via `--skip-checks` on build),
   `./equin build`, open `http://<worktree>.localhost:9000`, and load a surface
   that calls `useConfig(floatingBarConfig)`. Confirm a thrown error (caught by the
   nearest `error-boundary`, visible in the UI / browser console via
   `read_logs`) instead of silently showing defaults. Restore and rebuild.

6. **No regression on the happy path:** full `./equin build` succeeds, the app
   loads, and config-backed surfaces (floating bar toggle, reorder edit mode, theme)
   render real values with no spurious throws.
