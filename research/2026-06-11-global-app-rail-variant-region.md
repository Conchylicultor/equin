# App rail → variant-region: invert `--app-rail-width` ownership + fix sidebar collapse overlap

## Context

Two coupled problems surfaced while looking at the **floating** sidebar framing:

1. **Collapse overlap (bug).** When the sidebar is collapsed in `floating` (and `inset`)
   mode, the fixed sidebar panel slides left but stops with its right edge at
   `x = --app-rail-width` (2.5rem), landing its floating ring/border *on top of*
   the app rail. Because the fixed sidebar shares `z-nav` with the rail but comes
   later in the DOM, it paints over the rail — so you see the sidebar's border
   where the rail icons should be. Root cause: the off-canvas-collapsed `left`
   re-adds the rail width instead of fully clearing the viewport edge
   (`sidebar.tsx:233`).

2. **`--app-rail-width` ownership (footgun).** The rail's width is published as the
   `--app-rail-width` CSS var, consumed by the fixed sidebar to offset its left
   edge. Today `AppsLayout` *hardcodes* `--app-rail-width: 2.5rem`
   (`apps-layout.tsx:45`). A hideable rail would have to *remember* to drive that
   var to `0` — a classic "you must also update X" coupling. The rail is not
   self-contained: it reaches across into a sibling subtree via a var the layout
   owns.

**Constraint that shapes the whole design:** the `<Sidebar>` is a DOM *descendant*
of the `AppsLayout` container that sets the var (it inherits via CSS cascade);
`AppRail` is a *sibling* subtree. CSS custom properties only cascade **down**, so
the var must be set on the element that wraps **both** the rail and the app
content. A rail variant can only own the var if it owns that common-ancestor
wrapper — which is exactly how `sidebar-framing` variants own the
`SidebarProvider` wrapper and receive `body` as a prop.

**Intended outcome:** convert the app rail into a **variant-region** mirroring
`sidebar-framing` — variants `rail` (default) and `hidden`, **global** scope, with
the theme-engine picker. Each variant owns its wrapper and sets
`--app-rail-width` to its own width, so the var becomes the rail's *output
contract* and the hidden-rail footgun disappears. Bundle the independent
one-line collapse-overlap fix.

The rail variant-region is the blessed follow-up already scoped in
`research/2026-06-10-global-per-app-ui-personality.md` ("app-rail (`rail`/`hidden`,
*global* — proves the no-scope branch)").

## Design decisions

- **Region lives under `plugins/apps/plugins/app-rail-framing/`** (umbrella under
  `apps`), not under `plugins/ui/`. The `rail` variant must render `<AppRail>` and
  the `Apps.App.Render` slot — both `apps`-internal. Locating the region under
  `apps` keeps rail chrome ownership local and only adds a dependency on the
  generic factory `@plugins/ui/plugins/variant-region/*` — the same direction
  `sidebar-framing` uses.
- **`RailFramingProps` (`{ body: ReactNode }`) lives in a new `plugins/apps/core/`**,
  owned by the host (`apps`), exactly as `SidebarFramingProps` lives in
  `app-shell/core` rather than in `ui`.
- **`apps` defines a new generic slot `Apps.RailFraming`** (plain `defineSlot`,
  mirroring `AppShell.Framing` at `app-shell/web/slots.ts`). `AppsLayout` consumes
  it generically with an inline `DefaultRailFraming` fallback (mirroring
  `DefaultFlushFraming`). `AppsLayout` never imports a specific variant
  (collection-consumer rule).
- **Global scope** (`defineVariantRegion` called without `scope`), `defaultVariant: "rail"`.
- **Width SSOT:** the variant's container is the single source. `rail` sets
  `--app-rail-width: 2.5rem`; `AppRail` reads that same var via
  `w-(--app-rail-width)` (Tailwind v4 custom-prop syntax, already used for
  `w-(--sidebar-width)`). One literal per variant, no separate token, no
  `w-10`-vs-`2.5rem` drift.

## New files (mirror `sidebar-framing`)

```
plugins/apps/core/
  index.ts                      export type { RailFramingProps }
  types.ts                      RailFramingProps = { body: ReactNode }

plugins/apps/plugins/app-rail-framing/
  package.json                  @singularity/plugin-apps-app-rail-framing
  CLAUDE.md                     (autogen block; filled by ./equin build)
  core/
    index.ts                    export { appRailFraming }
    region.ts                   defineVariantRegion<RailFramingProps>({ id:"app-rail-framing",
                                  label:"App rail", defaultVariant:"rail" })   // no scope → global
  web/
    index.ts                    barrel + default plugin:
                                  contributions: [...appRailFramingWeb.contributions,
                                                  Apps.RailFraming({ component: appRailFramingWeb.Region })]
                                  re-export { AppRailFraming }
    region.ts                   export appRailFramingWeb = defineVariantRegionWeb(appRailFraming)
                                  export const AppRailFraming = { Variant: appRailFramingWeb.Variant }
  server/
    index.ts                    contributions: [variantRegionServerContribution(appRailFraming)]

  plugins/rail/
    package.json, CLAUDE.md
    web/index.ts                AppRailFraming.Variant({ id:"rail", label:"Rail", match:"rail", component: RailFraming })
    web/components/rail-framing.tsx

  plugins/hidden/
    package.json, CLAUDE.md
    web/index.ts                AppRailFraming.Variant({ id:"hidden", label:"Hidden", match:"hidden", component: HiddenFraming })
    web/components/hidden-framing.tsx
```

`apps/core` is a new runtime dir under the existing `apps` package (no separate
`package.json` — same as `app-shell`'s core+web under one package). Barrel must be
pure (types/re-exports only).

**`rail-framing.tsx`** (owns the wrapper + var + rail; the `2.5rem` SSOT):
```tsx
import type { RailFramingProps } from "@plugins/apps/core";
import { AppRail } from "@plugins/apps/web";

export function RailFraming({ body }: RailFramingProps) {
  return (
    <div className="flex h-full min-h-0"
         style={{ "--app-rail-width": "2.5rem" } as React.CSSProperties}>
      <AppRail />
      {body}
    </div>
  );
}
```

**`hidden-framing.tsx`** (no rail; var → 0, sidebar slides flush):
```tsx
import type { RailFramingProps } from "@plugins/apps/core";

export function HiddenFraming({ body }: RailFramingProps) {
  return (
    <div className="flex h-full min-h-0"
         style={{ "--app-rail-width": "0px" } as React.CSSProperties}>
      {body}
    </div>
  );
}
```

## Edits to existing files

### `plugins/apps/web/slots.ts` — add the slot
Add `defineSlot` import, a `RailFramingContribution` type, and `Apps.RailFraming`:
```ts
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { RailFramingProps } from "@plugins/apps/core";

export interface RailFramingContribution { component: ComponentType<RailFramingProps>; }

export const Apps = {
  App: defineRenderSlot< ... >("apps.app", { docLabel: (p) => p.tooltip }),
  RailFraming: defineSlot<RailFramingContribution>("apps.rail-framing", {
    docLabel: () => "Rail framing",
  }),
};
```

### `plugins/apps/web/components/app-rail.tsx` — self-sufficient + SSOT width
- Drop the `activeAppId` prop; call `useActiveApp()` internally
  (`../internal/use-active-app`, same plugin). Confirmed sole caller is `apps-layout.tsx`.
- Width: `w-10` → `w-(--app-rail-width)` (reads the var its parent variant sets).
```tsx
export function AppRail() {
  const activeAppId = useActiveApp()?.id;
  return (
    <div className="relative z-nav flex w-(--app-rail-width) shrink-0 flex-col items-center gap-1 border-r bg-background pt-3">
    ...
```

### `plugins/apps/web/index.ts` — export `AppRail`
The `rail` sub-plugin imports it via `@plugins/apps/web` (no deep import allowed):
```ts
export { AppRail } from "./components/app-rail";
```

### `plugins/apps/web/components/apps-layout.tsx` — consume slot, thread `body`
The flex container, the var, and `<AppRail/>` move OUT into the variants. Keep
`TooltipProvider` (outermost — `AppRail` uses `WithTooltip`; harmless over the
rail-less `hidden` variant), the redirect `useEffect`, `PaneBasePathContext`, and
`renderIsolated(Apps.App…)`. Add an inline `DefaultRailFraming` fallback (mirrors
`DefaultFlushFraming`).
```tsx
function DefaultRailFraming({ body }: RailFramingProps) {
  return (
    <div className="flex h-full min-h-0" style={{ "--app-rail-width": "2.5rem" } as React.CSSProperties}>
      <AppRail />{body}
    </div>
  );
}

export function AppsLayout() {
  // ...unchanged: activeApp, allApps, pathname, redirect useEffect, basePath...
  const body = (
    <div className="min-w-0 flex-1">
      {activeApp && (
        <PaneBasePathContext.Provider value={basePath}>
          {renderIsolated(Apps.App.id, activeApp as unknown as Contribution)}
        </PaneBasePathContext.Provider>
      )}
    </div>
  );
  const framing = Apps.RailFraming.useContributions()[0];
  const props: RailFramingProps = { body };
  return (
    <TooltipProvider delay={300}>
      {framing
        ? renderIsolated(Apps.RailFraming.id, framing as unknown as Contribution, props)
        : <DefaultRailFraming {...props} />}
    </TooltipProvider>
  );
}
```

### `plugins/framework/plugins/web-core/web/components/ui/sidebar.tsx:233` — collapse fix
Off-canvas-collapsed `left` must fully clear the viewport edge, not re-add the rail width:
```
- data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--app-rail-width,0px)-var(--sidebar-width))]
+ data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]
```
Leave the expanded `left-[var(--app-rail-width,0px)]` untouched. Correct for every
combination: expanded sits at the rail width (2.5rem or 0); collapsed goes fully
off-screen regardless of rail width or framing variant (matches the right side's
existing `*-1`). `--app-rail-width` has exactly these two consumers (verified), so
nothing else depends on the old math.

### `plugins/ui/plugins/variant-region/web/components/variant-region-picker.tsx` — global-scope fix
**Required** — the app-rail is the first *global* region and exposes a real bug:
the host (`createRegion`) reads `scopeId = core.scope === "app" && appId ? app:<id> : undefined`,
but the picker always writes to `useThemeScopeId()`, which becomes `app:<id>` once
any app's theme is forked. For a global region the picker would then write
`app:<id>` while the host reads base → the toggle silently no-ops. Make the
picker's scope mirror the host's rule:
```ts
const themeScope = useThemeScopeId();
const scopeId = core.scope === "app" ? themeScope : undefined;
```
App-scoped regions (`sidebar-framing`) are unchanged; global regions now edit and
read the same (base) scope.

## Registration

No manual edits — `web/src/plugins.ts` / `server-core/bin/plugins.ts` do **not**
exist; `web.generated.ts` and `server.generated.ts` are regenerated from the
filesystem by `./equin build`. Creating the `web/index.ts` / `server/index.ts`
files above and rebuilding registers everything. `dependsOn` is import-derived.
The `plugins-registry-in-sync` and `plugins-doc-in-sync` checks gate drift.

## Open risks

1. **Picker scope fix touches shared factory code.** Justified (a global region's
   picker must edit global scope) and provably inert for app-scoped regions. Confirm
   `useConfig`/`useSetConfig` with `scopeId: undefined` read/write base during
   implementation.
2. **`Apps.RailFraming` expects exactly one host contribution** (`framings[0]`) —
   same single-contribution expectation as `AppShell.Framing`; acceptable.
3. **`apps/core` is a brand-new runtime dir** — must satisfy barrel-purity and the
   one-barrel-per-runtime checks; `@plugins/apps/core` resolves by convention (no
   package.json export-map entry needed, same as `web`).

## Verification

1. `./equin build` (repo root) — regenerates both registries (expect 3 web +
   1 server new entries), the new `CLAUDE.md` autogen blocks, and
   `docs/plugins-details.md`.
2. `./equin check` — boundary checker (cross-plugin imports go through
   `@plugins/apps/web` + `@plugins/apps/core`, not deep paths), barrel-purity,
   lint, `plugins-registry-in-sync`, `plugins-doc-in-sync`.
3. Playwright e2e (`bun e2e/screenshot.mjs`) at `http://<worktree>.localhost:9000`:
   - Default = `rail`: 2.5rem icon rail renders; an app with a sidebar shows
     `[data-slot=sidebar-container]` `left: 2.5rem`.
   - Theme customizer → "App rail" group → "Hidden": rail disappears, sidebar
     `left` becomes `0px`, content fills width. Switch back to "Rail" → restored.
   - **Collapse-overlap regression:** set sidebar-framing to `floating`, collapse
     the sidebar — confirm **no** border/sliver artifact at the left edge. Repeat
     across `flush`/`inset` × `rail`/`hidden`.
   - **Global-scope picker:** fork an app's theme, then toggle the rail to Hidden
     from the forked customizer — confirm the live rail actually hides (proves the
     picker writes the scope the host reads).

## Critical files

- `plugins/apps/web/components/apps-layout.tsx`
- `plugins/apps/web/slots.ts`
- `plugins/apps/web/components/app-rail.tsx`
- `plugins/apps/web/index.ts`
- `plugins/apps/core/{index,types}.ts` (new)
- `plugins/apps/plugins/app-rail-framing/**` (new region + 2 variants)
- `plugins/framework/plugins/web-core/web/components/ui/sidebar.tsx`
- `plugins/ui/plugins/variant-region/web/components/variant-region-picker.tsx`
