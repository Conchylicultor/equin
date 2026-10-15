# A composition declares its homepage app

## Context

Bare `/` redirects to `defaultApp(apps)` (`plugins/apps-core/web/internal/resolve-app.ts:33`):
the `Apps.App` entry flagged `default: true`, else `apps[0]`. Today exactly one app claims
it, Home (`plugins/apps/plugins/home/plugins/shell/web/index.ts:22`), so on main `/` is the
Home gallery. Any composition without Home falls through to `apps[0]`, which is load order.
That is how equin.ai's `/` became `/debug/background` when debug leaked into the website
bundle.

Which app is the homepage is a property of **what is deployed**, not of an app's code. So it
moves to the composition manifest, reaches the browser through the per-composition web
registry at build time, and is validated by `composition-closure`. No code-level way to
claim `/` remains.

Decisions (confirmed with the user):

- Main's home is `home`, which keeps today's behaviour. The website's home is `website`.
- The app launcher's click and its "All apps" footer go to the **composition home**. That
  is one concept, with no separate "gallery" field.

## Design

### 1. Manifest field `home` (engine-opaque)

`plugins/plugin-meta/plugins/composition/core/config.ts`:

- Add `home: textField({ label: "Home app" })` to `itemFields`. Its value is an app id: the
  `id` of a `defineApp({...})` (`plugins/primitives/plugins/pane/core/route.ts:111`).
  - `""` means "no app". It is valid only when the bundle has no app (subsystems and packs).
  - Like `excludes` and `serve`, `manifestItemToManifest` (`core/manifest-map.ts`) drops
    it, so the closure engine never sees it. Extend the opacity test in `core/config.test.ts`.
- Seed values:
  - main: `home: "home"`
  - `agent-manager` and `agent-manager-lean`: `"agent-manager"`
  - `app(name, …)`: the helper sets `home: name`. Every `app()` row's name equals its
    `defineApp` id (home, pages, settings, studio, sonata, debug, deploy, file-explorer,
    website).
  - `subsystem()`, `pack()` and base-exclusions: `""`.
- `plugins/plugin-meta/plugins/composition/web/internal/manifests.ts:~150`: seed `home: ""`
  on newly drafted items, next to `excludes` and `serve`. The edit path keeps the field
  through its existing `...item` spread.

### 2. One resolver for "which app is this composition's home"

There is a new static (barrel-free) reader in `plugins/plugin-meta/plugins/composition/core/home.ts`:

- `declaredApps(tree): Map<appId, PluginId>` scans each plugin's `core/*.ts` for
  `defineApp({ id: "…" })`. It reuses and generalises the regex parser in
  `findDefineAppIconKey` (`plugins/framework/plugins/cli/plugins/release/cli/run.ts:250`).
  Release switches to a shared `readDefineApp(node) → { id, iconKey } | null`, so the
  repo ends up with one `defineApp` parser instead of two.
  - The shell that holds `defineApp` is the same plugin that contributes `Apps.App`. The
    existing `apps-core/app-icon` check already pairs the two per shell dir.
- `resolveCompositionHome({ tree, bundle, home })` returns a discriminated result, never a
  stand-in value. The possible results are:

  | Kind | Meaning |
  |---|---|
  | `{ kind: "app", appId }` | the home is a valid app in this bundle |
  | `{ kind: "none" }` | no home declared, and the bundle contains no app |
  | `{ kind: "error", reason: "missing", bundleApps }` | the bundle has apps but no home is declared |
  | `{ kind: "error", reason: "not-an-app", known }` | the home names no `defineApp` id in the repo |
  | `{ kind: "error", reason: "not-in-bundle", plugin }` | the app exists, but its shell is outside this bundle |
  | `{ kind: "error", reason: "home-without-apps" }` | a home is declared, but the bundle has no app |

Both the check (step 3) and codegen (step 4) call this one function, so they cannot
disagree.

### 3. `composition-closure` enforces it

In `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts`:

- Add a per-item rule in the `items` loop. It uses the same flattened `resolveComposition`
  bundle as rule 6 (~L449), and calls `resolveCompositionHome`.
- Any `error` fails, with a message naming the composition, the reason and the bundle's
  apps, and a hint pointing at `config.ts` / the Studio compositions pane.
- This covers a stray app in the website bundle: the home is still `website`, so `/` stays
  correct. It also covers a removed or renamed home app, which fails loudly.
- Update the check's `CLAUDE.md`.

### 4. Codegen: a composition registry names its composition

In `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` (approved
framework change):

- `renderCollectedDirRegistry` takes `composition: { id, bundle, home: string | null }`
  instead of the bare `bundle`.
  - For `membership: "composition"` dirs, `renderRegistry` also emits:
    ```ts
    export interface CompositionIdentity { id: string; home: string | null; }
    export const composition: CompositionIdentity = { id: "website", home: "website" };
    ```
  - `checkout`-membership dirs such as `exempt` belong to no composition and emit nothing.
  - This is generic: every composition registry says which composition it is. Only the web
    runtime reads `home` today.
- `buildRegistryGenContext` builds `ctx.main` as `{ id: MAIN_COMPOSITION_ID, bundle, home }`
  from `resolveMainComposition` plus main's manifest item, replacing `mainBundle`.
  - `committedRegistryBundle` becomes `committedRegistryComposition`.
- `generateCompositionRegistry({ root, composition, ctx })` and its caller in
  `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts` (~L440-510)
  pass the item's resolved home.
- Codegen calls `resolveCompositionHome` and **throws** on `error`, so a build can never
  emit a registry with a bad home, even with `--skip-checks`.
- `plugins-registry-in-sync` renders through the same function, so it picks up the new
  export automatically. The committed `{web,server,prewarm,deps}.generated.ts` files gain
  the `composition` export through `./singularity build`. Fix the check's stale `CLAUDE.md`
  while there.

### 5. Web runtime: `useComposition()` from web-sdk

The registry is importable only by the root, so the value travels through the plugin
context. No module-level setter and no request is involved.

- `plugins/framework/plugins/web-core/web/App.tsx`: import `{ webEntries, composition }`
  from `@composition-web-registry` and pass `composition` to `<PluginProvider>`.
- `plugins/framework/plugins/web-sdk/core/context.tsx`:
  - `PluginProvider` takes a required `composition: CompositionIdentity` prop.
  - `useComposition()` reads it and throws outside a provider (fail loudly).
  - Export the type and the hook from the core barrel.
- Tests that `vi.mock("@composition-web-registry")` (`web-core/web/__tests__/app-*.test.tsx`)
  add a `composition` export. A `web-sdk/core/testing` helper supplies a test composition
  for apps-core's jsdom tests.

### 6. apps-core: the home comes from the composition, nothing else

- `plugins/apps-core/web/slots.ts`: delete `default?: boolean` from `AppEntry`.
  `plugins/apps/plugins/home/plugins/shell/web/index.ts`: delete `default: true`.
- `plugins/apps-core/web/internal/resolve-app.ts`: replace `defaultApp` with:
  - a pure `homeApp(apps, homeId)` that returns `{ kind: "none" } | { kind: "app", app } | { kind: "unregistered", id }`;
  - a `useHomeApp()` hook built on `useComposition().home` and `Apps.App.useContributions()`.

  There is no `apps[0]` fallback. `unregistered` means the declared home's shell never
  contributed. App shells are in the eager tier, so this means a load error or a
  broken invariant. It renders the existing load-error / not-found surface naming the id,
  and never falls back to another app.
- Update the barrel export (`defaultApp` → `useHomeApp`, `homeApp`) and these call sites:
  - `apps-core/plugins/layout/web/components/apps-layout.tsx:118`: the `/` redirect target.
    Update the comment block at ~L50 and ~L131.
  - `apps-core/plugins/tabs/web/internal/use-tabs.tsx:445`: the boot seed.
  - `apps-core/plugins/tabs/web/internal/use-tabs.tsx:850`: the last-tab-closed reseed.
  - `apps-core/plugins/app-launcher/web/components/app-launcher.tsx:124`: the launcher click
    and "All apps". Update the app-launcher `CLAUDE.md` ("the composition's home app").
- Leave `surface-body.tsx:101` and `solo-placement.tsx` alone: their `.default` belongs to
  surface placements, not apps.

### 7. Studio: edit the home like the rest of the manifest

In `plugins/apps/plugins/studio/plugins/compositions`:

- Add a "Home" column to `compositions-list.tsx`, next to `serve`, that shows the app name.
- Add an editor that writes `item.home` through the same config write path as the serve
  toggle and draft save (`setConfig("manifests", …)`).
- Its options are the `Apps.App` contributions whose `_pluginId` (stamped by the web-sdk
  registry, `registry.ts:110`) is in the composition's resolved bundle, read from the
  existing composition membership hooks.
- The check stays the backstop for layer edits made outside Studio.

## Critical files

- `plugins/plugin-meta/plugins/composition/core/{config.ts,home.ts (new),manifest-map.ts,config.test.ts}`
- `plugins/plugin-meta/plugins/composition/web/internal/manifests.ts`
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`
- `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts`
- `plugins/framework/plugins/cli/plugins/release/cli/run.ts`, which moves onto the shared `defineApp` reader
- `plugins/framework/plugins/tooling/plugins/checks/plugins/{composition-closure,plugins-registry-in-sync}/`
- `plugins/framework/plugins/web-sdk/core/context.tsx` and `plugins/framework/plugins/web-core/web/App.tsx`
- `plugins/apps-core/web/{slots.ts,internal/resolve-app.ts,index.ts}` and the layout, tabs and app-launcher call sites
- `plugins/apps/plugins/home/plugins/shell/web/index.ts`
- `plugins/apps/plugins/studio/plugins/compositions/web/components/compositions-list.tsx`

The plan must also check the boundary-config rows: codegen (`framework/tooling`) importing
`plugin-meta/composition/core` must already be allowed (it imports the closure core today),
and the import graph must stay acyclic.

## Verification

1. Unit tests (`./singularity test plugins/plugin-meta/plugins/composition`): cover every
   `resolveCompositionHome` arm, and check that `home` is opaque to the mapper.
2. Run `./singularity check composition-closure`. It should pass on the seeds. Then make
   each failure temporarily and confirm it fails with a precise message:
   - website `home: "debug"` (not in bundle)
   - `home: "nope"` (not an app)
   - `home: ""` on website (missing)
3. Run `./singularity build`. Confirm that `plugins-registry-in-sync` passes, and that the
   committed `web.generated.ts` exports `composition = { id: "singularity", home: "home" }`.
4. Run the apps-core jsdom tests (`./singularity test plugins/apps-core`): `/` redirects to
   the home and never to `apps[0]`; closing the last tab reseeds the home; an unregistered
   home shows the error surface.
5. Run e2e with `screenshot.ts --path /` on main, which should land on `/home`. Build and
   serve the `website` composition and screenshot `/`, which should land on `/website`.
6. In the Studio compositions pane, change a composition's home and confirm that the
   config changes and the check accepts or rejects it.
